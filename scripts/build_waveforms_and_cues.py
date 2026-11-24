#!/usr/bin/env python3
"""Precompute 160-bar waveform peaks and representative snippet cues.

For full-length tracks (Tier B `mp3_320_url` or encoded/staged newer streams):
  - Computes 160 perceptual amplitude bars (`0..100` uint8 ints) across the full track.
  - Cross-correlates the 8-bar `audio-previews-v1/<id>.mp3` clip envelope against the
    full track (100 Hz RMS + onset-flux normalized sliding correlation via FFT) to
    pinpoint `preview_start_sec` and `preview_dur_sec` within +/-10 ms.
  - Falls back cleanly to downbeat-flux groove window (`[0.12*dur .. 0.58*dur]`) if
    a preview clip is unavailable or comes from an alternate arrangement (`r < 0.50`).

Writes:
  - `~/tmp/music_map_staging/waveforms_and_cues.json` (active catalog tracks: full-track
    peaks/cues for tracks with live full-length URLs, real preview peaks for preview-only
    tracks until `--promote-staged` / `encode_releases.py --upload-streams` runs).
  - Optional `--staged-full-out` precomputing full-track peaks/cues for all staged newer
    masters in `/tmp/swarm-1445092/newer_raw_audio/` so stream encoding + promotion takes <1 min.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve

SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_STAGING = Path.home() / "tmp" / "music_map_staging"
DEFAULT_GH_CACHE = Path("/tmp/swarm-1445092/gh_audio_cache")
DEFAULT_NEWER_STAGE = Path("/tmp/swarm-1445092/newer_raw_audio")
N_BARS = 160
DEC_SR = 8000
ENV_HOP = 80  # 10 ms frames -> 100 Hz envelope


def decode_mono_8k(ffmpeg_bin: str, path: Path) -> np.ndarray:
    res = subprocess.run(
        [
            ffmpeg_bin, "-nostdin", "-v", "error",
            "-i", str(path),
            "-vn", "-ac", "1", "-ar", str(DEC_SR), "-f", "f32le", "-",
        ],
        capture_output=True,
        check=True,
    )
    return np.frombuffer(res.stdout, dtype=np.float32)


def compute_160_peaks(samples: np.ndarray, n_bars: int = N_BARS) -> list[int]:
    """Compute `n_bars` normalized perceptual waveform bar heights in `0..100`."""
    total = len(samples)
    if total < n_bars:
        return [0] * n_bars

    edges = np.linspace(0, total, n_bars + 1, dtype=np.int64)
    raw = np.zeros(n_bars, dtype=np.float64)
    abs_s = np.abs(samples)
    for i in range(n_bars):
        seg = abs_s[edges[i] : edges[i + 1]]
        if len(seg) == 0:
            continue
        rms = float(np.sqrt(np.mean(seg * seg)))
        p95 = float(np.percentile(seg, 95.0))
        raw[i] = 0.65 * rms + 0.35 * p95

    ref = float(np.percentile(raw, 99.0))
    if ref <= 1e-6:
        ref = float(np.max(raw))
    if ref <= 1e-6:
        return [0] * n_bars

    norm = np.clip(raw / ref, 0.0, 1.0) ** 0.85
    peaks = []
    for i in range(n_bars):
        if raw[i] <= 1e-5:
            peaks.append(0)
        else:
            peaks.append(int(min(100, max(1, round(float(norm[i]) * 100.0)))))
    return peaks


def _envelope_feature(samples: np.ndarray) -> np.ndarray:
    n_fr = len(samples) // ENV_HOP
    if n_fr < 4:
        return np.zeros(4, dtype=np.float64)
    fr = samples[: n_fr * ENV_HOP].reshape(n_fr, ENV_HOP).astype(np.float64)
    rms = np.sqrt(np.mean(fr * fr, axis=1))
    flux = np.maximum(0.0, np.diff(rms, prepend=rms[0]))
    # Blend RMS contour + onset transients for sharp beat-locked alignment
    return rms + 1.5 * flux


def fallback_groove_cue(samples: np.ndarray, bpm: float) -> tuple[float, float]:
    """Representative 8-bar cue fallback if preview clip correlation is unavailable."""
    dur_sec = len(samples) / float(DEC_SR)
    safe_bpm = bpm if 50.0 <= bpm <= 200.0 else 120.0
    bar_sec = 4.0 * (60.0 / safe_bpm)
    clip_bars = 8 if 8 * bar_sec <= 30.0 else 4
    clip_dur = min(dur_sec, clip_bars * bar_sec)
    if dur_sec <= clip_dur + 0.5:
        return 0.0, round(dur_sec, 3)

    env = _envelope_feature(samples)
    env_sr = DEC_SR / float(ENV_HOP)
    lo = int(max(bar_sec, dur_sec * 0.12) * env_sr)
    hi = int(min(dur_sec - clip_dur - 0.1, dur_sec * 0.58) * env_sr)
    win = max(10, int(clip_dur * env_sr))
    if hi <= lo:
        return round(max(0.0, dur_sec * 0.15), 3), round(clip_dur, 3)

    csum = np.concatenate([[0.0], np.cumsum(env)])
    best_i = lo
    best_e = -1.0
    step = max(1, int(0.25 * env_sr))
    for idx in range(lo, hi + 1, step):
        end_i = min(len(env), idx + win)
        if end_i <= idx:
            continue
        score = (csum[end_i] - csum[idx]) / (end_i - idx)
        if score > best_e:
            best_e = score
            best_i = idx
    return round(best_i / env_sr, 3), round(clip_dur, 3)


def align_preview_to_full(
    y_full: np.ndarray,
    y_prev: np.ndarray | None,
    bpm: float = 120.0,
) -> tuple[float, float, float]:
    """Return `(preview_start_sec, preview_dur_sec, corr_confidence)`."""
    full_dur = len(y_full) / float(DEC_SR)
    if y_prev is None or len(y_prev) < DEC_SR:
        st, dur = fallback_groove_cue(y_full, bpm)
        return st, dur, 0.0

    prev_dur = len(y_prev) / float(DEC_SR)
    if prev_dur >= full_dur - 0.25:
        return 0.0, round(min(prev_dur, full_dur), 3), 1.0

    e_full = _envelope_feature(y_full)
    e_prev_all = _envelope_feature(y_prev)
    env_sr = DEC_SR / float(ENV_HOP)

    # Trim 150ms micro-fade/MP3-padding edges from preview template
    trim = min(int(0.15 * env_sr), max(0, len(e_prev_all) // 8))
    e_tpl = e_prev_all[trim : len(e_prev_all) - trim] if trim > 0 else e_prev_all
    m = len(e_tpl)
    if m < 25 or len(e_full) <= m + 2:
        st, dur = fallback_groove_cue(y_full, bpm)
        return st, round(min(prev_dur, full_dur - st), 3), 0.0

    tpl_zero = e_tpl - float(np.mean(e_tpl))
    tpl_norm = float(np.linalg.norm(tpl_zero))
    if tpl_norm <= 1e-8:
        return 0.0, round(min(prev_dur, full_dur), 3), 0.0

    num = fftconvolve(e_full, tpl_zero[::-1], mode="valid")
    ones = np.ones(m, dtype=np.float64)
    sum_x = fftconvolve(e_full, ones, mode="valid")
    sum_x2 = fftconvolve(e_full * e_full, ones, mode="valid")
    var_x = np.maximum(0.0, sum_x2 - (sum_x * sum_x) / float(m))
    denom = np.sqrt(var_x) * tpl_norm

    valid = denom > 1e-8
    if not np.any(valid):
        return 0.0, round(min(prev_dur, full_dur), 3), 0.0

    corr = np.where(valid, num / np.maximum(denom, 1e-8), -1.0)
    best_idx = int(np.argmax(corr))
    best_r = float(corr[best_idx])

    if best_r < 0.50:
        st, _ = fallback_groove_cue(y_full, bpm)
        return st, round(min(prev_dur, full_dur - st), 3), round(best_r, 4)

    start_sec = max(0.0, (best_idx - trim) / env_sr)
    start_sec = min(start_sec, max(0.0, full_dur - prev_dur))
    return round(start_sec, 3), round(min(prev_dur, full_dur - start_sec), 3), round(best_r, 4)


def extract_youtube_id(links: dict | None) -> str:
    if not links:
        return ""
    for key in ("youtube", "youtube_music"):
        url = str(links.get(key) or "")
        m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", url)
        if m:
            return m.group(1)
    return ""


def download_if_missing(url: str, dst: Path) -> Path | None:
    if dst.exists() and dst.stat().st_size > 1024:
        return dst
    if not url:
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dst.write_bytes(resp.read())
    return dst


def _process_one(
    ffmpeg_bin: str,
    track: dict,
    full_path: Path | None,
    prev_path: Path | None,
    stream_url: str,
    youtube_id: str,
) -> tuple[str, dict, float]:
    tid = track["id"]
    bpm = float(track.get("effective_bpm") or track.get("bpm") or 120.0)
    y_prev = decode_mono_8k(ffmpeg_bin, prev_path) if (prev_path and prev_path.exists()) else None

    if full_path and full_path.exists():
        y_full = decode_mono_8k(ffmpeg_bin, full_path)
        full_dur = round(len(y_full) / float(DEC_SR), 2)
        peaks = compute_160_peaks(y_full)
        p_start, p_dur, corr = align_preview_to_full(y_full, y_prev, bpm=bpm)
    elif y_prev is not None and len(y_prev) > 0:
        full_dur = round(len(y_prev) / float(DEC_SR), 2)
        peaks = compute_160_peaks(y_prev)
        p_start, p_dur, corr = 0.0, round(full_dur, 3), 1.0
    else:
        raise RuntimeError(f"No audio available for track {tid}")

    rec: dict = {
        "peaks": peaks,
        "preview_start_sec": p_start,
        "preview_dur_sec": p_dur,
        "full_duration_sec": full_dur,
    }
    if stream_url:
        rec["stream_url"] = stream_url
    if youtube_id:
        rec["youtube_id"] = youtube_id
    return tid, rec, corr


def main() -> None:
    ap = argparse.ArgumentParser(description="Build 160-bar waveforms and cross-correlated preview cues.")
    ap.add_argument("--staging-dir", type=Path, default=DEFAULT_STAGING)
    ap.add_argument("--gh-cache", type=Path, default=DEFAULT_GH_CACHE)
    ap.add_argument("--newer-stage-dir", type=Path, default=DEFAULT_NEWER_STAGE)
    ap.add_argument("--out", type=Path, default=DEFAULT_STAGING / "waveforms_and_cues.json")
    ap.add_argument(
        "--staged-full-out",
        type=Path,
        default=DEFAULT_NEWER_STAGE / "precomputed_full_waveforms.json",
        help="Also precompute full-track waveforms/cues for staged >=2015 raw masters.",
    )
    ap.add_argument(
        "--promote-staged-streams",
        action="store_true",
        help="Include staged full-track waveforms/cues directly in --out (when stream_url is active).",
    )
    ap.add_argument("--workers", type=int, default=min(32, os.cpu_count() or 8))
    args = ap.parse_args()

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise SystemExit("ffmpeg not found on PATH")

    cat = json.loads((args.staging_dir / "catalog_587_enriched.json").read_text(encoding="utf-8"))["tracks"]
    excl_path = args.staging_dir / "exclusions.json"
    excl_ids = set(json.loads(excl_path.read_text(encoding="utf-8"))["excluded_ids"]) if excl_path.exists() else set()
    dl_res = json.loads((args.staging_dir / "archive_dl_results.json").read_text(encoding="utf-8"))
    an_by_id = {
        t["id"]: t
        for t in json.loads((args.staging_dir / "analyzed_559.json").read_text(encoding="utf-8")).get("tracks", [])
    }

    newer_man_path = args.newer_stage_dir / "manifest.json"
    newer_man = json.loads(newer_man_path.read_text(encoding="utf-8")) if newer_man_path.exists() else {}

    existing_out = {}
    if args.out.exists():
        try:
            existing_out = json.loads(args.out.read_text(encoding="utf-8"))
        except Exception:
            existing_out = {}

    active_tracks = [t for t in cat if t["id"] not in excl_ids]
    print(f"Processing {len(active_tracks)} active catalog tracks (excluded={len(excl_ids)}) with {args.workers} workers...")

    out_map: dict[str, dict] = {}
    tier_b_corrs: list[float] = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = []
        for t in active_tracks:
            tid = t["id"]
            an = an_by_id.get(tid, {})
            prev_url = an.get("preview_url") or f"https://github.com/BillTribble/music-map/releases/download/audio-previews-v1/{tid}.mp3"
            prev_path = download_if_missing(prev_url, args.gh_cache / "previews" / f"{tid}.mp3")

            stream_url = str(existing_out.get(tid, {}).get("stream_url") or newer_man.get(tid, {}).get("stream_url") or "")
            yt_id = extract_youtube_id(an.get("links") or t.get("links"))

            full_path: Path | None = None
            if t["tier"] == "archive_dl":
                mp3_url = dl_res.get(tid, {}).get("mp3_320_url") or an.get("mp3_320_url") or ""
                full_path = download_if_missing(mp3_url, args.gh_cache / "tier_b" / f"{tid}.mp3")
            elif stream_url or args.promote_staged_streams:
                sp = newer_man.get(tid, {}).get("staged_path")
                if sp and Path(sp).exists():
                    full_path = Path(sp)

            futs.append((t["tier"], pool.submit(_process_one, ffmpeg_bin, t, full_path, prev_path, stream_url, yt_id)))

        for tier, fut in futs:
            tid, rec, corr = fut.result()
            out_map[tid] = rec
            if tier == "archive_dl":
                tier_b_corrs.append(corr)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out_map, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")

    high_corr = sum(1 for c in tier_b_corrs if c >= 0.85)
    med_corr = float(np.median(tier_b_corrs)) if tier_b_corrs else 0.0
    print(
        f"Wrote {args.out} ({len(out_map)} tracks) | "
        f"Tier B aligned={len(tier_b_corrs)} (median corr={med_corr:.4f}, r>=0.85: {high_corr}/{len(tier_b_corrs)})"
    )

    # Also precompute full-track waveforms & cues for all staged >=2015 masters so stream promotion is instant!
    if newer_man and args.staged_full_out:
        staged_map: dict[str, dict] = {}
        newer_corrs: list[float] = []
        newer_tracks = [t for t in active_tracks if t["tier"] != "archive_dl" and t["id"] in newer_man]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            nfuts = []
            for t in newer_tracks:
                tid = t["id"]
                an = an_by_id.get(tid, {})
                prev_path = args.gh_cache / "previews" / f"{tid}.mp3"
                sp = Path(newer_man[tid]["staged_path"])
                yt_id = extract_youtube_id(an.get("links") or t.get("links"))
                s_url = str(newer_man[tid].get("stream_url") or "")
                nfuts.append(pool.submit(_process_one, ffmpeg_bin, t, sp, prev_path, s_url, yt_id))
            for fut in as_completed(nfuts):
                tid, rec, corr = fut.result()
                staged_map[tid] = rec
                newer_corrs.append(corr)

        args.staged_full_out.parent.mkdir(parents=True, exist_ok=True)
        args.staged_full_out.write_text(
            json.dumps(staged_map, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8"
        )
        nhigh = sum(1 for c in newer_corrs if c >= 0.85)
        nmed = float(np.median(newer_corrs)) if newer_corrs else 0.0
        print(
            f"Precomputed staged >=2015 full-track waveforms -> {args.staged_full_out} "
            f"({len(staged_map)} tracks, median corr={nmed:.4f}, r>=0.85: {nhigh}/{len(newer_corrs)})"
        )


if __name__ == "__main__":
    main()

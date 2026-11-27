#!/usr/bin/env python3
"""Musical DSP Drum-Presence Gate & Drop Preview Analyzer for Bill Tribble Music Map.

Analyzes all catalog tracks in `js/data.js` in three musical DSP stages:
  Step A — Drum Presence Gate (`has_drums`):
    - Margin-separated Fitzgerald (2010) HPSS percussive-to-total energy ratio,
      percussive RMS share, 40-150 Hz low-band kick transient flux & share,
      3.5-7.6 kHz hi-hat/snare percussive sizzle, transient sharpness crest factor,
      and autocorrelation pulse clarity (`65-190 BPM`).
    - Strictly skips drumless tracks (pure ambient, drone, solo piano/strings,
      spoken word, drumless orchestral/choir) — leaving their existing preview cues
      100% untouched.

  Step B — Drop Identification on Drum Tracks (`t_drop`):
    - Resolves true musical 4/4 tempo (`84-178 BPM`, handling half/double-time tags
      such as 85 -> 170 BPM DnB or 70 -> 140 BPM UK bass/dubstep and polyrhythmic
      ratios) and tracks percussive beat grid via Ellis (2007) dynamic programming.
    - Computes 1-bar normalized envelopes for sub + bass (`30-180 Hz`), percussive
      drums + low-band kick (`40-7600 Hz` HPSS percussive + `40-150 Hz` kick), and
      full-band loudness.
    - Identifies genuine drops (`t_drop >= ~4 bars` into track) preceded by an
      ambient/drum-sparse/bass-sparse intro and/or a 1-4 bar pre-drop quiet dip,
      followed by a sharp simultaneous surge in drums + sub-bass that sustains
      across `>= 8 bars` at the track's full main-body level.

  Step C — Preview Cue Placement (`t_preview`):
    - Sets `preview_start_sec = max(0.0, snap_to_beat(t_drop - 4 * bar_sec))` so
      listeners hear ~4 musical bars of atmospheric intro / pre-drop quiet build
      and hit the drop right on bar 5.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import multiprocessing
import os
import pickle
import subprocess
import tempfile
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import stft

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_JS = ROOT / "js" / "data.js"
DEFAULT_OUT_JSON = ROOT / "scripts" / "drop_previews.json"
DEFAULT_AUDIO_CACHE = Path(os.environ.get("DROP_AUDIO_CACHE") or (Path(tempfile.gettempdir()) / "drop_audio_cache"))

# Curated drop/preview overrides for bass-looper / ambient-build tracks that bypass the HPSS drum gate
DROP_PREVIEW_OVERRIDES: dict[str, dict] = {
    "archive_2018_23_62": {  # Spectacular fail (post-024518: RC-505 pre-drop build at 30.0s -> sub-bass drop at 44.25s)
        "has_drop": True,
        "drop_sec": 44.25,
        "preview_start_sec": 30.0,
        "preview_dur_sec": 24.48,
        "lead_in_sec": 14.25,
    },
}

SR = 16000
N_FFT = 1024
HOP = 320  # 50.0 Hz (20 ms per STFT frame)
FPS = SR / HOP  # 50.0
BIN_FRAMES = 5  # 100 ms (10.0 Hz stored envelopes)
ENV_HZ = FPS / BIN_FRAMES  # 10.0 Hz

FREQS = np.fft.rfftfreq(N_FFT, d=1.0 / SR)
SUB_BASS_MASK = (FREQS >= 30.0) & (FREQS <= 180.0)
PURE_SUB_MASK = (FREQS >= 30.0) & (FREQS <= 95.0)
KICK_MASK = (FREQS >= 40.0) & (FREQS <= 150.0)
SNARE_MASK = (FREQS > 150.0) & (FREQS <= 3500.0)
HAT_MASK = (FREQS > 3500.0) & (FREQS <= 7600.0)
DRUM_BAND_MASK = (FREQS >= 40.0) & (FREQS <= 7600.0)


def load_corpus_data(data_js_path: Path) -> tuple[str, dict]:
    raw = data_js_path.read_text(encoding="utf-8")
    marker = "window.CORPUS_DATA = "
    idx = raw.index(marker)
    header = raw[: idx + len(marker)]
    body = raw[idx + len(marker) :].rstrip()
    if body.endswith(";"):
        body = body[:-1]
    return header, json.loads(body)


def ensure_local_audio(track: dict, cache_dir: Path) -> Path:
    tid = str(track["id"])
    for ext in (".m4a", ".webm", ".mp3"):
        cand = cache_dir / f"{tid}{ext}"
        if cand.exists() and cand.stat().st_size > 8000:
            return cand

    cache_dir.mkdir(parents=True, exist_ok=True)
    urls = [
        u for u in (
            track.get("stream_url"),
            track.get("mp3_320_url"),
            track.get("mp3_url"),
            track.get("preview_url"),
        )
        if isinstance(u, str) and u
    ]
    last_err = None
    for url in urls:
        low = url.lower()
        ext = ".m4a" if ".m4a" in low else (".webm" if ".webm" in low else ".mp3")
        dest = cache_dir / f"{tid}{ext}"
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "music-map-drop-dsp/1.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    blob = resp.read()
                if len(blob) < 4000:
                    raise RuntimeError(f"Tiny audio payload ({len(blob)}B) from {url}")
                tmp = cache_dir / f"{tid}{ext}.part"
                tmp.write_bytes(blob)
                os.replace(tmp, dest)
                return dest
            except Exception as exc:
                last_err = str(exc)
                time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"Could not fetch audio for {tid}: {last_err}")


def decode_mono(path: Path) -> tuple[np.ndarray, float]:
    ffmpeg_bin = "/usr/bin/ffmpeg" if os.path.exists("/usr/bin/ffmpeg") else "ffmpeg"
    raw = subprocess.check_output(
        [
            ffmpeg_bin, "-nostdin", "-v", "error",
            "-t", "540", "-i", str(path),
            "-ac", "1", "-ar", str(SR), "-f", "f32le", "-",
        ]
    )
    arr = np.frombuffer(raw, dtype=np.float32)
    return arr, float(len(arr)) / SR


def _bin_10hz(arr: np.ndarray, mode: str = "mean") -> np.ndarray:
    n = (len(arr) // BIN_FRAMES) * BIN_FRAMES
    if n == 0:
        return arr.astype(np.float32)
    reshaped = arr[:n].reshape(-1, BIN_FRAMES)
    if mode == "max":
        return np.max(reshaped, axis=1).astype(np.float32)
    return np.mean(reshaped, axis=1).astype(np.float32)


def hpss_margin_power(S: np.ndarray, margin: float = 2.2) -> tuple[np.ndarray, np.ndarray]:
    H_med = median_filter(S, size=(1, 21))
    P_med = median_filter(S, size=(17, 1))
    H2 = H_med * H_med
    P2 = P_med * P_med
    m2 = float(margin * margin)
    mask_p = P2 / (P2 + m2 * H2 + 1e-18)
    mask_h = H2 / (H2 + m2 * P2 + 1e-18)
    P_tot = S * S
    return P_tot * mask_h, P_tot * mask_p


def ellis_beat_track(onset_env: np.ndarray, bpm_target: float, fps: float = FPS) -> np.ndarray:
    n = len(onset_env)
    if n < 20:
        return np.array([], dtype=np.float32)
    local = onset_env.astype(np.float64)
    local = local / (float(np.percentile(local, 95)) + 1e-9)
    period = max(6.0, fps * 60.0 / max(55.0, min(200.0, bpm_target)))
    min_p = max(4, int(round(period * 0.55)))
    max_p = max(min_p + 2, int(round(period * 1.80)))
    lags = np.arange(min_p, max_p + 1)
    log_pen = -140.0 * (np.log(lags / period) ** 2)

    cum = local.copy()
    back = np.full(n, -1, dtype=np.int32)
    for t_idx in range(min_p, n):
        hi_lag = min(max_p, t_idx)
        cand_lags = lags[: hi_lag - min_p + 1]
        prev_idx = t_idx - cand_lags
        scores = cum[prev_idx] + log_pen[: len(cand_lags)]
        best_k = int(np.argmax(scores))
        if scores[best_k] > 0.0:
            cum[t_idx] = local[t_idx] + scores[best_k]
            back[t_idx] = prev_idx[best_k]

    tail_win = min(n, max(int(period * 2), 20))
    cur = int(n - tail_win + np.argmax(cum[n - tail_win :]))
    beats = []
    while cur >= 0:
        beats.append(cur)
        cur = int(back[cur])
    beats.reverse()
    return np.array(beats, dtype=np.float32) / float(fps)


def extract_track_dsp(args_tuple: tuple[dict, str]) -> dict:
    t, cache_dir_str = args_tuple
    tid = str(t["id"])
    path = ensure_local_audio(t, Path(cache_dir_str))
    y, decoded_dur = decode_mono(path)
    dur = float(t.get("full_duration_sec") or decoded_dur)
    if decoded_dur < 8.0:
        return {"id": tid, "dur": dur, "decoded_dur": decoded_dur, "short": True}

    _, _, Zxx = stft(
        y, fs=SR, window="hann", nperseg=N_FFT, noverlap=N_FFT - HOP, boundary="zeros", padded=True
    )
    S = np.abs(Zxx).astype(np.float32) + 1e-10
    del y, Zxx

    P = S * S
    P_harm, P_perc = hpss_margin_power(S, margin=2.2)
    del S

    tot_e = np.sum(P[DRUM_BAND_MASK, :], axis=0, dtype=np.float64) + 1e-12
    perc_e = np.sum(P_perc[DRUM_BAND_MASK, :], axis=0, dtype=np.float64)
    harm_e = np.sum(P_harm[DRUM_BAND_MASK, :], axis=0, dtype=np.float64)

    kick_tot_e = np.sum(P[KICK_MASK, :], axis=0, dtype=np.float64) + 1e-12
    kick_perc_e = np.sum(P_perc[KICK_MASK, :], axis=0, dtype=np.float64)

    sub_rms = np.sqrt(np.mean(P[SUB_BASS_MASK, :], axis=0, dtype=np.float64))
    pure_sub_rms = np.sqrt(np.mean(P[PURE_SUB_MASK, :], axis=0, dtype=np.float64))
    perc_rms = np.sqrt(np.mean(P_perc[DRUM_BAND_MASK, :], axis=0, dtype=np.float64))
    kick_rms = np.sqrt(np.mean(P_perc[KICK_MASK, :], axis=0, dtype=np.float64))
    snare_rms = np.sqrt(np.mean(P_perc[SNARE_MASK, :], axis=0, dtype=np.float64))
    hat_rms = np.sqrt(np.mean(P_perc[HAT_MASK, :], axis=0, dtype=np.float64))
    harm_rms = np.sqrt(np.mean(P_harm[DRUM_BAND_MASK, :], axis=0, dtype=np.float64))
    full_rms = np.sqrt(np.mean(P, axis=0, dtype=np.float64))
    del P, P_harm

    kick_db = 10.0 * np.log10(P_perc[KICK_MASK, :] + 1e-12)
    kick_flux = np.mean(np.maximum(0.0, np.diff(kick_db, axis=1, prepend=kick_db[:, :1])), axis=0)
    del kick_db

    perc_db = 10.0 * np.log10(P_perc[DRUM_BAND_MASK, :] + 1e-12)
    perc_flux = np.mean(np.maximum(0.0, np.diff(perc_db, axis=1, prepend=perc_db[:, :1])), axis=0)
    del perc_db, P_perc

    win_f = min(len(perc_rms), int(25.0 * FPS))
    if len(perc_rms) > win_f and win_f > int(4 * FPS):
        csum = np.concatenate([[0.0], np.cumsum(perc_rms)])
        best_s = int(np.argmax(csum[win_f:] - csum[:-win_f]))
        sl = slice(best_s, best_s + win_f)
    else:
        sl = slice(0, len(perc_rms))

    seg_pf = perc_flux[sl]
    seg_kf = kick_flux[sl]

    def _ac_clarity(sig: np.ndarray) -> tuple[float, float, np.ndarray]:
        z = sig - np.mean(sig)
        denom = float(np.dot(z, z)) + 1e-12
        ac = np.correlate(z, z, mode="full")[len(z) - 1 :] / denom
        lo = int(FPS * 60.0 / 190.0)
        hi = min(len(ac) - 1, int(FPS * 60.0 / 65.0))
        if hi <= lo:
            return 0.0, 120.0, ac
        idx = int(lo + np.argmax(ac[lo : hi + 1]))
        return float(ac[idx]), float(60.0 * FPS / idx), ac

    pulse_ac, ac_bpm, ac_full = _ac_clarity(seg_pf)
    kick_pulse_ac, kick_ac_bpm, _ = _ac_clarity(seg_kf)
    fast_lo, fast_hi = int(FPS * 60.0 / 182.0), min(len(ac_full) - 1, int(FPS * 60.0 / 155.0))
    fast_ac = float(np.max(ac_full[fast_lo : fast_hi + 1])) if fast_hi > fast_lo else 0.0

    cat_bpm = float(t.get("bpm") or 120.0)
    norm_bpm = cat_bpm * 2.0 if cat_bpm < 84.0 else (cat_bpm * 0.5 if cat_bpm > 180.0 else cat_bpm)
    beat_times = ellis_beat_track(perc_flux, norm_bpm, FPS)

    return {
        "id": tid,
        "dur": round(dur, 3),
        "decoded_dur": round(decoded_dur, 3),
        "short": False,
        "perc_ratio_active": float(np.sum(perc_e[sl]) / (np.sum(tot_e[sl]) + 1e-12)),
        "perc_harm_ratio_active": float(np.sum(perc_e[sl]) / (np.sum(harm_e[sl]) + 1e-12)),
        "perc_ratio_global": float(np.sum(perc_e) / (np.sum(tot_e) + 1e-12)),
        "kick_perc_share_active": float(np.sum(kick_perc_e[sl]) / (np.sum(kick_tot_e[sl]) + 1e-12)),
        "prms_to_frms_active": float(np.mean(perc_rms[sl]) / (np.mean(full_rms[sl]) + 1e-9)),
        "krms_to_frms_active": float(np.mean(kick_rms[sl]) / (np.mean(full_rms[sl]) + 1e-9)),
        "pulse_ac": pulse_ac,
        "ac_bpm": ac_bpm,
        "kick_pulse_ac": kick_pulse_ac,
        "kick_ac_bpm": kick_ac_bpm,
        "fast_ac": fast_ac,
        "kick_flux_p90": float(np.percentile(seg_kf, 90)),
        "perc_flux_p90": float(np.percentile(seg_pf, 90)),
        "onset_crest": float(np.percentile(seg_pf, 95) / (np.mean(seg_pf) + 1e-6)),
        "kick_crest": float(np.percentile(kick_rms[sl], 95) / (np.mean(kick_rms[sl]) + 1e-9)),
        "norm_bpm": norm_bpm,
        "beat_times": beat_times,
        "sub_rms_10hz": _bin_10hz(sub_rms, "mean"),
        "pure_sub_10hz": _bin_10hz(pure_sub_rms, "mean"),
        "perc_rms_10hz": _bin_10hz(perc_rms, "mean"),
        "kick_rms_10hz": _bin_10hz(kick_rms, "mean"),
        "snare_rms_10hz": _bin_10hz(snare_rms, "mean"),
        "hat_rms_10hz": _bin_10hz(hat_rms, "mean"),
        "harm_rms_10hz": _bin_10hz(harm_rms, "mean"),
        "full_rms_10hz": _bin_10hz(full_rms, "mean"),
        "kick_flux_10hz": _bin_10hz(kick_flux, "max"),
        "perc_flux_10hz": _bin_10hz(perc_flux, "max"),
    }


def evaluate_drum_gate(t: dict, f: dict) -> tuple[bool, float]:
    """Step A: Strict DSP drum-presence gate (`has_drums`)."""
    if t.get("is_spoken_word") or f.get("short"):
        return False, 0.0

    perc_act = f["perc_ratio_active"]
    perc_glob = f["perc_ratio_global"]
    kick_share = f["kick_perc_share_active"]
    prms_share = f["prms_to_frms_active"]
    pulse_ac = max(f["pulse_ac"], f["kick_pulse_ac"])
    kick_p90 = f["kick_flux_p90"]
    crest = f["onset_crest"]

    pf10 = f["perc_flux_10hz"]
    kf10 = f["kick_flux_10hz"]
    perc10 = f["perc_rms_10hz"]
    hat10 = f["hat_rms_10hz"]
    fr10 = f["full_rms_10hz"] + 1e-9

    q75_p = float(np.percentile(perc10, 75))
    act_mask = perc10 >= q75_p
    hat_to_full = float(np.mean(hat10[act_mask]) / (np.mean(fr10[act_mask]) + 1e-9))

    n2 = len(pf10) // 20
    if n2 >= 4:
        pf2 = np.max(pf10[: n2 * 20].reshape(n2, 20), axis=1)
        kf2 = np.max(kf10[: n2 * 20].reshape(n2, 20), axis=1)
        pr_rel2 = np.mean(perc10[: n2 * 20].reshape(n2, 20), axis=1) / np.mean(fr10[: n2 * 20].reshape(n2, 20), axis=1)
        drum_win_frac = float(np.mean((pf2 > 2.3) & (kf2 > 4.8) & (pr_rel2 > 0.135)))
        drum_win_sec = drum_win_frac * (n2 * 2.0)
    else:
        drum_win_frac = 0.0
        drum_win_sec = 0.0

    cl_label = str(t.get("cluster_label") or "").lower()
    title_low = str(t.get("title") or "").lower()
    inst_tags = t.get("instrument_tags") or []

    # Strictly protect drumless ambient, solo piano, and drumless orchestral/choir pieces
    if "ambient & soundscapes" in cl_label and not ("Drums" in inst_tags and perc_act >= 0.10 and hat_to_full >= 0.025):
        return False, 0.0
    if "piano only" in title_low or (inst_tags == ["Piano"] and hat_to_full < 0.025):
        return False, 0.0
    if "orchestral & choir" in cl_label and ("Drums" not in inst_tags or perc_act < 0.11 or hat_to_full < 0.035):
        return False, 0.0

    if perc_glob < 0.022 or drum_win_sec < 12.0 or drum_win_frac < 0.10:
        return False, 0.0
    if hat_to_full < 0.016 and perc_act < 0.095 and not (kick_p90 >= 7.2 and kick_share >= 0.08 and crest >= 3.4 and pulse_ac >= 0.55):
        return False, 0.0

    s_energy = np.clip((perc_act - 0.038) / 0.085, 0.0, 1.4) * 0.55 + np.clip((prms_share - 0.15) / 0.16, 0.0, 1.4) * 0.45
    s_kick = np.clip((kick_p90 - 4.5) / 4.5, 0.0, 1.4) * 0.55 + np.clip((kick_share - 0.020) / 0.10, 0.0, 1.4) * 0.45
    s_transient = np.clip((crest - 1.90) / 1.40, 0.0, 1.4)
    s_pulse = np.clip((pulse_ac - 0.12) / 0.35, 0.0, 1.4)
    s_hat = np.clip((hat_to_full - 0.014) / 0.050, 0.0, 1.3)
    score = 0.28 * s_energy + 0.22 * s_kick + 0.20 * s_transient + 0.15 * s_pulse + 0.15 * s_hat

    pass_standard = (
        perc_act >= 0.045
        and prms_share >= 0.16
        and kick_p90 >= 4.6
        and crest >= 2.15
        and pulse_ac >= 0.20
        and score >= 0.42
    )
    pass_dense_kit = (
        perc_act >= 0.105
        and prms_share >= 0.27
        and hat_to_full >= 0.055
        and kick_p90 >= 6.0
        and crest >= 1.50
        and (pulse_ac >= 0.20 or f["fast_ac"] >= 0.18)
    )
    pass_syncopated = (
        perc_act >= 0.110
        and prms_share >= 0.22
        and hat_to_full >= 0.025
        and kick_p90 >= 5.5
        and crest >= 2.25
        and pulse_ac >= 0.11
    )
    pass_filtered_kick = (
        perc_act >= 0.065
        and prms_share >= 0.19
        and kick_p90 >= 7.2
        and kick_share >= 0.08
        and crest >= 3.40
        and pulse_ac >= 0.55
    )
    return bool(pass_standard or pass_dense_kit or pass_syncopated or pass_filtered_kick), round(float(score), 3)


def resolve_musical_bpm(t: dict, f: dict) -> float:
    raw_bpm = float(t.get("bpm") or 120.0)
    cl_label = str(t.get("cluster_label") or "").lower()
    is_dnb = "jungle" in cl_label or "drum & bass" in cl_label or "dnb" in cl_label

    bpm = raw_bpm
    if bpm < 84.0:
        bpm *= 2.0
    elif is_dnb and bpm < 96.0:
        bpm *= 2.0
    elif bpm > 180.0:
        bpm *= 0.5

    ac_bpm = float(f.get("ac_bpm") or bpm)
    while ac_bpm < 84.0:
        ac_bpm *= 2.0
    while ac_bpm > 180.0:
        ac_bpm *= 0.5

    if f.get("pulse_ac", 0.0) >= 0.50:
        ratio = ac_bpm / max(1.0, bpm)
        if 1.44 <= ratio <= 1.56 or 0.63 <= ratio <= 0.69 or 1.28 <= ratio <= 1.38:
            bpm = ac_bpm

    return float(np.clip(bpm, 84.0, 178.0))


def snap_to_beat_grid(sec: float, beat_times: np.ndarray | None, beat_sec: float) -> float:
    if sec <= 0.15:
        return 0.0
    if beat_times is not None and len(beat_times) >= 8:
        idx = int(np.argmin(np.abs(beat_times - sec)))
        cand = float(beat_times[idx])
        if abs(cand - sec) <= 0.42 * beat_sec:
            return max(0.0, cand)
    return max(0.0, sec)


def detect_drop(t: dict, f: dict) -> dict | None:
    """Step B & C: Detect genuine drop `t_drop` and compute beat-aligned `t_preview = t_drop - 4 bars`."""
    dur = float(f["dur"])
    dec_dur = float(f.get("decoded_dur") or dur)
    eff_dur = min(dur, dec_dur)
    if eff_dur < 36.0:
        return None

    bpm = resolve_musical_bpm(t, f)
    beat_sec = 60.0 / bpm
    bar_sec = 4.0 * beat_sec  # 1 musical 4/4 bar

    mush_onset = float(t["mush_onset_sec"]) if t.get("has_mush") and t.get("mush_onset_sec") else eff_dur
    valid_end = min(eff_dur - 2.0, mush_onset)

    post_bars = 8.0
    post_sec = post_bars * bar_sec
    min_drop_sec = max(6.5, 3.75 * bar_sec)
    max_drop_sec = valid_end - post_sec
    if max_drop_sec <= min_drop_sec + 2.0:
        return None

    hz = ENV_HZ
    n_valid = min(len(f["sub_rms_10hz"]), int(valid_end * hz))
    if n_valid < int((min_drop_sec + post_sec) * hz):
        return None

    sub = f["sub_rms_10hz"][:n_valid].astype(np.float64)
    perc = f["perc_rms_10hz"][:n_valid].astype(np.float64)
    kick = f["kick_rms_10hz"][:n_valid].astype(np.float64)
    full = f["full_rms_10hz"][:n_valid].astype(np.float64)
    kflux = f["kick_flux_10hz"][:n_valid].astype(np.float64)
    pflux = f["perc_flux_10hz"][:n_valid].astype(np.float64)

    bar_bins = max(8, int(round(bar_sec * hz)))
    post_bins = max(8 * bar_bins, int(round(post_sec * hz)))
    pre4_bins = 4 * bar_bins
    pre2_bins = 2 * bar_bins
    pre1_bins = bar_bins

    # Normalize against 90th percentile of 1-bar smoothed envelopes
    sub_ref = float(np.percentile(uniform_filter1d(sub, size=bar_bins, mode="nearest"), 90)) + 1e-9
    perc_ref = float(np.percentile(uniform_filter1d(perc, size=bar_bins, mode="nearest"), 90)) + 1e-9
    kick_ref = float(np.percentile(uniform_filter1d(kick, size=bar_bins, mode="nearest"), 90)) + 1e-9
    full_ref = float(np.percentile(uniform_filter1d(full, size=bar_bins, mode="nearest"), 90)) + 1e-9

    B = np.clip(sub / sub_ref, 0.0, 1.35)
    D = np.clip(0.52 * (perc / perc_ref) + 0.48 * (kick / kick_ref), 0.0, 1.35)
    L = np.clip(full / full_ref, 0.0, 1.35)
    C = 0.52 * D + 0.48 * B

    cs_B = np.concatenate([[0.0], np.cumsum(B)])
    cs_D = np.concatenate([[0.0], np.cumsum(D)])
    cs_L = np.concatenate([[0.0], np.cumsum(L)])
    cs_C = np.concatenate([[0.0], np.cumsum(C)])

    def wmean(cs: np.ndarray, i0: int, i1: int) -> float:
        i0 = max(0, min(len(cs) - 1, i0))
        i1 = max(i0 + 1, min(len(cs) - 1, i1))
        return float((cs[i1] - cs[i0]) / (i1 - i0))

    n_scan_start = int(round(min_drop_sec * hz))
    n_scan_end = min(n_valid - post_bins, int(round(max_drop_sec * hz)))
    if n_scan_end <= n_scan_start:
        return None

    open4_D = wmean(cs_D, 0, min(n_valid, pre4_bins))
    open4_B = wmean(cs_B, 0, min(n_valid, pre4_bins))
    open8_D = wmean(cs_D, 0, min(n_valid, 2 * pre4_bins))
    open8_B = wmean(cs_B, 0, min(n_valid, 2 * pre4_bins))
    starts_full_immediately = (open4_D >= 0.62 and open4_B >= 0.58) or (open8_D >= 0.66 and open8_B >= 0.62)

    n_pos = max(1, n_valid - post_bins + 1)
    win8_D = (cs_D[post_bins : post_bins + n_pos] - cs_D[:n_pos]) / float(post_bins)
    win8_B = (cs_B[post_bins : post_bins + n_pos] - cs_B[:n_pos]) / float(post_bins)
    win8_full_val = np.where((win8_D >= 0.54) & (win8_B >= 0.52), 0.52 * win8_D + 0.48 * win8_B, 0.0)
    running_max_full = np.maximum.accumulate(win8_full_val)

    candidates = []
    for idx in range(n_scan_start, n_scan_end + 1, 2):
        post_D = wmean(cs_D, idx, idx + post_bins)
        post_B = wmean(cs_B, idx, idx + post_bins)
        post_C = wmean(cs_C, idx, idx + post_bins)
        if post_D < 0.56 or post_B < 0.54 or post_C < 0.62:
            continue

        active_bars = 0
        for b_i in range(8):
            b0 = idx + b_i * bar_bins
            b1 = min(n_valid, b0 + bar_bins)
            if wmean(cs_C, b0, b1) >= 0.46 and wmean(cs_D, b0, b1) >= 0.40:
                active_bars += 1
        if active_bars < 6:
            continue
        if wmean(cs_C, idx + 4 * bar_bins, idx + post_bins) < 0.70 * post_C:
            continue

        first_bar_C = wmean(cs_C, idx, idx + bar_bins)
        first_2bar_C = wmean(cs_C, idx, idx + 2 * bar_bins)
        if first_bar_C < 0.72 * post_C or first_2bar_C < 0.80 * post_C:
            continue

        intro_D = wmean(cs_D, 0, idx)
        intro_B = wmean(cs_B, 0, idx)
        intro_C = wmean(cs_C, 0, idx)

        pre4_D = wmean(cs_D, max(0, idx - pre4_bins), idx)
        pre4_B = wmean(cs_B, max(0, idx - pre4_bins), idx)
        pre4_C = wmean(cs_C, max(0, idx - pre4_bins), idx)
        pre2_C = wmean(cs_C, max(0, idx - pre2_bins), idx)
        pre1_C = wmean(cs_C, max(0, idx - pre1_bins), idx)
        min_pre3_bar = min(
            wmean(cs_C, max(0, idx - (k + 1) * bar_bins), max(1, idx - k * bar_bins))
            for k in range(min(3, max(1, idx // bar_bins)))
        )

        prior_end_limit = idx - 3 * bar_bins - post_bins
        max_prior_full = float(running_max_full[min(len(running_max_full) - 1, prior_end_limit)]) if prior_end_limit >= 0 else 0.0

        has_ambient_or_partial_intro = (
            not starts_full_immediately
            and max_prior_full < 0.58
            and (
                intro_C <= 0.58 * post_C
                or intro_D <= 0.50 * post_D
                or intro_B <= 0.48 * post_B
            )
        )
        has_local_surge = (
            pre4_C <= 0.65 * post_C
            or (pre4_D <= 0.55 * post_D and pre4_C <= 0.72 * post_C)
            or (pre4_B <= 0.52 * post_B and pre4_C <= 0.72 * post_C)
            or (min_pre3_bar <= 0.44 * post_C and pre2_C <= 0.62 * post_C)
        )
        boundary_step = first_bar_C - pre1_C
        if boundary_step < 0.14 and not (post_B - pre1_C >= 0.24 and pre4_C <= 0.65 * post_C):
            continue

        has_deep_breakdown_drop = (
            not starts_full_immediately
            and pre4_C <= 0.42 * post_C
            and min_pre3_bar <= 0.34 * post_C
            and post_C >= max(0.74, 1.18 * max_prior_full)
            and boundary_step >= 0.24
        )

        if not ((has_ambient_or_partial_intro and has_local_surge) or has_deep_breakdown_drop):
            continue

        contrast_ratio = post_C / max(0.12, min(pre4_C, pre2_C))
        quiet_dip_bonus = max(0.0, 0.50 - min_pre3_bar / max(0.2, post_C)) * 0.8
        score = (
            0.35 * post_C
            + 0.30 * boundary_step
            + 0.25 * min(2.0, (contrast_ratio - 1.0) * 0.55)
            + quiet_dip_bonus
        )
        if score >= 0.46:
            candidates.append((idx, score, post_C, post_D, post_B, pre4_C, min_pre3_bar))

    if not candidates:
        return None

    clusters = []
    merge_bins = int(round(2.5 * bar_bins))
    for cand in candidates:
        if not clusters or cand[0] - clusters[-1][-1][0] > merge_bins:
            clusters.append([cand])
        else:
            clusters[-1].append(cand)

    cluster_peaks = [max(cl, key=lambda x: x[1]) for cl in clusters]
    best_overall_body = max(cp[2] for cp in cluster_peaks)
    best_overall_score = max(cp[1] for cp in cluster_peaks)

    chosen = cluster_peaks[0]
    for cp in cluster_peaks:
        if cp[2] >= 0.85 * best_overall_body and cp[1] >= 0.72 * best_overall_score:
            chosen = cp
            break

    raw_idx = chosen[0]
    lo_r = max(2, raw_idx - 5)
    hi_r = min(n_valid - 4, raw_idx + 6)
    best_r = raw_idx
    best_jump = -1e9
    for r in range(lo_r, hi_r + 1):
        step_c = float(np.mean(C[r : r + 6]) - np.mean(C[max(0, r - 4) : r]))
        flux_bonus = 0.015 * float(kflux[r] + pflux[r])
        val = step_c + flux_bonus
        if val > best_jump:
            best_jump = val
            best_r = r

    t_drop_raw = best_r / hz
    t_drop = snap_to_beat_grid(t_drop_raw, f.get("beat_times"), beat_sec)
    lead_in_sec = 4.0 * bar_sec
    t_prev_raw = max(0.0, t_drop - lead_in_sec)
    t_preview = snap_to_beat_grid(t_prev_raw, f.get("beat_times"), beat_sec)

    prev_dur = float(np.clip(12.0 * bar_sec, 16.0, 32.0))
    if t_preview + prev_dur > valid_end:
        prev_dur = max(12.0, valid_end - t_preview)

    return {
        "has_drums": True,
        "has_drop": True,
        "drop_sec": round(t_drop, 2),
        "preview_start_sec": round(t_preview, 2),
        "preview_dur_sec": round(prev_dur, 2),
        "lead_in_sec": round(t_drop - t_preview, 2),
        "musical_bpm": round(bpm, 2),
        "bar_sec": round(bar_sec, 3),
        "drop_score": round(float(chosen[1]), 3),
        "post_drum_norm": round(float(chosen[3]), 2),
        "post_sub_norm": round(float(chosen[4]), 2),
        "pre4_combo_norm": round(float(chosen[5]), 2),
        "min_pre3_norm": round(float(chosen[6]), 2),
    }


def is_psychedailies_track(t: dict) -> bool:
    era = str(t.get("era") or t.get("era_id") or "").strip().lower()
    tid = str(t.get("id") or "").strip().lower()
    return era == "psychedailies" or tid.startswith("psychedailies_")


def apply_drop_previews_to_corpus(data: dict, drop_map: dict[str, dict]) -> int:
    """Surgically update preview cues on drop tracks across `tracks`, `eras`, and `phases`."""
    updated_ids = set()

    def _patch_track_obj(tr: dict) -> None:
        tid = str(tr.get("id") or "")
        is_psy = is_psychedailies_track(tr)
        entry = DROP_PREVIEW_OVERRIDES.get(tid) or drop_map.get(tid)
        if entry and entry.get("has_drop"):
            tr["has_drop"] = True
            tr["drop_sec"] = float(entry["drop_sec"])
            tr["preview_start_sec"] = 0.0 if is_psy else float(entry["preview_start_sec"])
            tr["preview_dur_sec"] = float(entry["preview_dur_sec"])
            updated_ids.add(tid)
        else:
            tr.pop("has_drop", None)
            tr.pop("drop_sec", None)
        if is_psy:
            tr["preview_start_sec"] = 0.0
            tr["cue_sec"] = 0.0
            updated_ids.add(tid)

    for tr in data.get("tracks", []):
        if isinstance(tr, dict):
            _patch_track_obj(tr)

    for group_key in ("eras", "phases"):
        for grp in data.get(group_key, []):
            if isinstance(grp, dict):
                for tr in grp.get("tracks", []):
                    if isinstance(tr, dict):
                        _patch_track_obj(tr)

    return len(updated_ids)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-js", type=Path, default=DEFAULT_DATA_JS)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_AUDIO_CACHE)
    parser.add_argument("--features-cache", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_JSON)
    parser.add_argument("--extra-out", type=Path, default=None)
    parser.add_argument("--apply-data-js", action="store_true")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    t0 = time.time()
    header, data = load_corpus_data(args.data_js)
    tracks = data.get("tracks", [])

    feats: dict[str, dict] = {}
    if args.features_cache and args.features_cache.exists():
        feats = pickle.loads(args.features_cache.read_bytes())

    missing = [t for t in tracks if str(t["id"]) not in feats]
    if missing:
        print(f"Extracting DSP envelopes for {len(missing)}/{len(tracks)} tracks ({args.workers} workers)...")
        ctx = multiprocessing.get_context("spawn")
        work_items = [(t, str(args.cache_dir)) for t in missing]
        with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, mp_context=ctx) as pool:
            futs = [pool.submit(extract_track_dsp, item) for item in work_items]
            for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
                res = fut.result()
                feats[res["id"]] = res
                if idx % 50 == 0 or idx == len(missing):
                    print(f"  [{idx}/{len(missing)}] extracted ({time.time() - t0:.1f}s)")
        if args.features_cache:
            args.features_cache.parent.mkdir(parents=True, exist_ok=True)
            args.features_cache.write_bytes(pickle.dumps(feats, protocol=pickle.HIGHEST_PROTOCOL))

    out_records: dict[str, dict] = {}
    drum_count = 0
    drop_count = 0
    cluster_stats: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])

    for t in tracks:
        tid = str(t["id"])
        is_psy = is_psychedailies_track(t)
        cl = str(t.get("cluster_label") or "Unknown")
        cluster_stats[cl][0] += 1
        f = feats[tid]
        has_drums, drum_score = evaluate_drum_gate(t, f)
        prev_before = 0.0 if is_psy else round(float(t.get("preview_start_sec") or 0.0), 2)
        if not has_drums:
            ov = DROP_PREVIEW_OVERRIDES.get(tid)
            if ov and ov.get("has_drop"):
                drop_count += 1
                cluster_stats[cl][2] += 1
                rec = {
                    "id": tid,
                    "title": t.get("title", tid),
                    "cluster_label": cl,
                    "is_ai": bool(t.get("is_ai")),
                    "has_drums": False,
                    "drum_score": drum_score,
                    "old_preview_start_sec": prev_before,
                    **ov,
                }
                if is_psy:
                    rec["preview_start_sec"] = 0.0
                out_records[tid] = rec
            else:
                out_records[tid] = {
                    "id": tid,
                    "title": t.get("title", tid),
                    "cluster_label": cl,
                    "is_ai": bool(t.get("is_ai")),
                    "has_drums": False,
                    "drum_score": drum_score,
                    "has_drop": False,
                    "old_preview_start_sec": prev_before,
                    "preview_start_sec": 0.0 if is_psy else prev_before,
                }
            continue

        drum_count += 1
        cluster_stats[cl][1] += 1
        drop_info = DROP_PREVIEW_OVERRIDES.get(tid) or detect_drop(t, f)
        if drop_info:
            drop_count += 1
            cluster_stats[cl][2] += 1
            rec = {
                "id": tid,
                "title": t.get("title", tid),
                "cluster_label": cl,
                "is_ai": bool(t.get("is_ai")),
                "drum_score": drum_score,
                "old_preview_start_sec": prev_before,
                **drop_info,
            }
            if is_psy:
                rec["preview_start_sec"] = 0.0
            out_records[tid] = rec
        else:
            out_records[tid] = {
                "id": tid,
                "title": t.get("title", tid),
                "cluster_label": cl,
                "is_ai": bool(t.get("is_ai")),
                "has_drums": True,
                "drum_score": drum_score,
                "has_drop": False,
                "old_preview_start_sec": prev_before,
                "preview_start_sec": 0.0 if is_psy else prev_before,
            }

    payload = {
        "summary": {
            "total_tracks": len(tracks),
            "drum_tracks": drum_count,
            "drumless_tracks": len(tracks) - drum_count,
            "drop_tracks": drop_count,
            "clusters": {
                cl: {"total": st[0], "drums": st[1], "drops": st[2]}
                for cl, st in sorted(cluster_stats.items(), key=lambda kv: -kv[1][0])
            },
        },
        "tracks": out_records,
    }

    serialized = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(serialized, encoding="utf-8")
    if args.extra_out:
        args.extra_out.parent.mkdir(parents=True, exist_ok=True)
        args.extra_out.write_text(serialized, encoding="utf-8")

    print(
        f"Analyzed {len(tracks)} tracks in {time.time() - t0:.2f}s -> "
        f"drums={drum_count}, drumless={len(tracks) - drum_count}, drops_updated={drop_count}"
    )

    if args.apply_data_js:
        updated_n = apply_drop_previews_to_corpus(data, out_records)
        out_js = header + json.dumps(data, separators=(",", ":"), ensure_ascii=False) + ";\n"
        args.data_js.write_text(out_js, encoding="utf-8")
        print(f"Applied drop preview cues to {updated_n} tracks in {args.data_js} ({args.data_js.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()

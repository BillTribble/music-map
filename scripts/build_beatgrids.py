#!/usr/bin/env python3
"""Offline Beat-Grid, Downbeat, Phrase & Groove (4x4 / broken / ambient) Builder for Music Map.

Adapts Bill Tribble's DJ-Vibes DSP pipeline (`BillTribble/DJ-Vibes`: `dsp_models.py`,
`genre_tempo.py`, and Mixed-In-Key-calibrated `dj_vibes_params.json`) across all tracks
in `js/data.js`, writing compact offline beat-grid metadata into `js/beatgrids.js`
(`window.BEAT_GRIDS` & `window.MUSIC_MAP_BEATGRIDS`) without modifying `js/data.js`.

Per-track fields emitted in `js/beatgrids.js`:
  - `bpm`: True DJ mixing tempo (BPM, octave-corrected for 4/4 house/techno & DnB/jungle)
  - `first_beat_sec`: Calibrated first beat timestamp in `[0, 60/bpm)` (+12ms MIK transient offset)
  - `bar_offset`: Beat index `0..3` from `first_beat_sec` landing on Beat 1 of each 4/4 bar
  - `phrase_bar`: Bar index `0..3` from `first_bar_sec` landing on Bar 1 of each 4-bar phrase
  - `beat_clarity`: Normalized beat-grid pulse clarity in `[0, 1]`
  - `energy_dj`: Calibrated DJ-Vibes 1..10 whole-track energy rating
  - `groove`: `"4x4"` | `"broken"` | `"ambient"`
  - `cue_in_sec`: Bar-aligned clean DJ mix-in downbeat timestamp (seconds)
  - `mix_out_sec`: 4-bar phrase-aligned DJ mix-out timestamp (seconds) leaving >= 5 bars of audio
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import multiprocessing
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_JS = ROOT / "js" / "data.js"
DEFAULT_DROP_JSON = ROOT / "scripts" / "drop_previews.json"
DEFAULT_PARAMS_JSON = ROOT / "scripts" / "dj_vibes_params.json"
DEFAULT_OUT_JS = ROOT / "js" / "beatgrids.js"
DEFAULT_CACHE_DIR = Path(
    os.environ.get("BEATGRID_AUDIO_CACHE")
    or "/tmp/swarm-1445092/drop_audio_cache"
)

# ---- DJ-Vibes DSP Constants (from BillTribble/DJ-Vibes dsp_models.py) ----
SR = 22050
NFFT = 2048
HOP = 512
MAX_S = 420
FPS = SR / HOP
T_OFF = (HOP + NFFT / 2) / SR
ONSET_LAG_S = 0.012  # Empirical +12ms transient/MIK calibration (DJ-Vibes bd-234)
LMAX = int(5.5 * FPS)
BANDS = [
    ("sub", 20, 100),
    ("bass", 100, 300),
    ("lowmid", 300, 1000),
    ("mid", 1000, 3000),
    ("high", 3000, 8000),
    ("air", 8000, 11025),
]
ENV_BANDS = (("low", 20, 200), ("mid", 200, 2000), ("high", 2000, 10000))
WIN_COLS = (
    "db", "cen", "flat", "sub", "bass", "lowmid", "mid", "high", "air",
    "flux", "kick", "onsets", "kicks", "peak_db", "clip",
)
CLIP_LEVEL = 10 ** (-0.5 / 20)
WIN_ROWS = int(2 * FPS)
WIN_S = WIN_ROWS * HOP / SR

_DNB_RE = re.compile(
    r"drum\s*(?:&|and|n|'n')?\s*bass|\bdnb\b|\bd\s?&\s?b\b|jungle|breakcore|liquid\s*funk|neurofunk|jump[\s-]*up",
    re.IGNORECASE,
)

FOUR_FLOOR_CLUSTERS = {
    "d1_dub_techno",
    "d3_house_deep",
    "d5_electro_techno",
}
BROKEN_CLUSTERS = {
    "d7_dnb_breaks",
    "d9_uk_bass",
    "d6_idm_industrial",
    "d4_indie_guitar",
}
AMBIENT_RHYTHM_TAGS = {
    "Beatless ambient wash",
    "Dark ambient drone",
    "Weightless ambient drift",
    "Organic vocal / melodic phrasing",
    "Acoustic / electric guitar demo",
}

# Ground-truth DAW / acoustically verified BPM overrides so rebuilds never regress subharmonic or ceiling-lag outliers.
BPM_OVERRIDES: dict[str, float] = {
    "psychedailies_26": 125.0,     # '24' — Ableton 24.als <Tempo Manual="125">, 4/4, 96 beats = 46.08s
    "ai_music_123_fc0278": 100.0,  # 'Scary moombah muertos' — 100 BPM moombahton (was 198.77 fallback)
    "ai_music_190_26d13e": 112.35, # 'Spiro Vapourer disguised (Cover)' — 112.35 BPM (was halved to 56.17)
    "archive_2018_23_42": 98.66,   # 'FF33b 02 bass cut' — 98.66 BPM (was doubled via stale 198.77 rhythm_tag)
    "present_ambient_7": 95.05,    # 'Edgeware Rd' — 95.05 BPM (was doubled via stale 198.77 rhythm_tag)
}

# Exact verified downbeat & 4-bar phrase anchor overrides where arrangement intros start off-beat (e.g. Beat 1 silent).
BEATGRID_OVERRIDES: dict[str, dict] = {
    "psychedailies_26": {
        "bpm": 125.0,
        "first_beat_sec": 0.004,
        "bar_offset": 0,
        "phrase_bar": 0,
        "groove": "4x4",
        "cue_in_sec": 0.0,
        "audible_end_sec": 46.08,
        "mix_out_sec": 42.244,
        "phrase_fade_sec": 42.244,
    },
}


def is_psychedailies_track(track: dict) -> bool:
    era = str(track.get("era") or track.get("era_id") or "").strip().lower()
    tid = str(track.get("id") or "").strip().lower()
    return era == "psychedailies" or tid.startswith("psychedailies_")


def compute_audible_end_sec(track: dict, full_dur: float) -> float:
    """Find last sustained musical energy above near-silence across `full_dur` (post-024701)."""
    eff_end = float(full_dur)
    if track.get("has_mush") is True and track.get("mush_onset_sec"):
        mush_lim = float(track["mush_onset_sec"]) + 3.0
        if 12.0 < mush_lim < eff_end:
            eff_end = mush_lim
    peaks = track.get("peaks") or []
    if len(peaks) < 16 or full_dur <= 6.0:
        return round(eff_end, 3)

    pk = np.asarray(peaks, dtype=np.float64)
    n = len(pk)
    max_bin = min(n - 1, max(0, int(math.floor((eff_end / full_dur) * n)) - 1))
    if max_bin < 8:
        return round(eff_end, 3)

    active_slice = pk[: max_bin + 1]
    nonzero = active_slice[active_slice > 2.0]
    sample = nonzero if len(nonzero) >= 6 else active_slice
    p80 = float(np.percentile(sample, 80))
    p50 = float(np.percentile(sample, 50))
    if p80 <= 5.0:
        return round(eff_end, 3)

    thr = float(np.clip(min(0.18 * p80, 0.45 * p50), 4.0, 22.0))
    min_bin = max(3, int(0.22 * (max_bin + 1)))
    last_sustained = max_bin
    while last_sustained > min_bin:
        cur = float(pk[last_sustained])
        prev = float(pk[last_sustained - 1])
        nxt = float(pk[last_sustained + 1]) if last_sustained + 1 <= max_bin else 0.0
        if (cur >= thr and (prev >= thr * 0.72 or nxt >= thr * 0.72)) or (0.5 * (cur + prev) >= thr):
            break
        last_sustained -= 1

    aud_end = min(eff_end, ((last_sustained + 1) / n) * full_dur)
    if eff_end - aud_end < 0.5:
        return round(eff_end, 3)
    return round(aud_end, 3)


def compute_psychedailies_tail_mixout(
    audible_end: float,
    groove: str,
    bpm_out: float,
    fb_out: float,
    bar_offset: int,
) -> float:
    """Place outgoing Psychedailies mix-out right at the very tail before `audible_end` (post-024688)."""
    beat_sec = 60.0 / max(45.0, bpm_out)
    bar_sec = 4.0 * beat_sec
    first_bar = fb_out + int(bar_offset) * beat_sec
    if groove == "ambient":
        fade_s = min(2.4, max(1.5, 0.08 * audible_end))
        return round(max(0.5, audible_end - fade_s), 4)
    min_tail = max(2.0, min(3.8, 1.35 * bar_sec))
    target_max = audible_end - min_tail
    b_idx = int(math.floor((target_max - first_bar + 0.05) / bar_sec))
    if b_idx >= 1:
        mo = first_bar + b_idx * bar_sec
        if audible_end - mo > 4.4 and (audible_end - (mo + bar_sec)) >= max(1.8, 0.95 * bar_sec):
            b_idx += 1
            mo = first_bar + b_idx * bar_sec
        return round(mo, 4)
    return round(max(0.5, audible_end - min(3.2, 0.25 * audible_end)), 4)

_PARAMS_CACHE: dict | None = None
_GRID_BPM: np.ndarray | None = None
_GRID_LAGS: np.ndarray | None = None


def get_params(params_path: Path = DEFAULT_PARAMS_JSON) -> dict:
    global _PARAMS_CACHE
    if _PARAMS_CACHE is None:
        _PARAMS_CACHE = json.loads(params_path.read_text(encoding="utf-8"))
    return _PARAMS_CACHE


def load_corpus_tracks(data_js_path: Path) -> list[dict]:
    raw = data_js_path.read_text(encoding="utf-8")
    marker = "window.CORPUS_DATA = "
    idx = raw.index(marker)
    body = raw[idx + len(marker) :].rstrip()
    if body.endswith(";"):
        body = body[:-1]
    data = json.loads(body)
    return data.get("tracks", [])


def ensure_local_audio(track: dict, cache_dir: Path) -> Path:
    tid = str(track["id"])
    for ext in (".m4a", ".webm", ".mp3", ".wav", ".flac"):
        cand = cache_dir / f"{tid}{ext}"
        if cand.exists() and cand.stat().st_size > 8000:
            return cand

    cache_dir.mkdir(parents=True, exist_ok=True)
    urls = [
        u
        for u in (
            track.get("stream_url"),
            track.get("mp3_320_url"),
            track.get("mp3_url"),
            track.get("preview_url"),
        )
        if isinstance(u, str) and u.startswith("http")
    ]
    last_err = None
    for url in urls:
        low = url.lower()
        ext = ".m4a" if ".m4a" in low else (".webm" if ".webm" in low else ".mp3")
        dest = cache_dir / f"{tid}{ext}"
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "music-map-beatgrid/1.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    blob = resp.read()
                if len(blob) < 4000:
                    raise RuntimeError(f"Tiny audio payload ({len(blob)}B)")
                tmp = cache_dir / f"{tid}{ext}.part"
                tmp.write_bytes(blob)
                os.replace(tmp, dest)
                return dest
            except Exception as exc:
                last_err = str(exc)
                time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"Could not fetch audio for {tid}: {last_err}")


def decode_audio_djvibes(path: Path) -> tuple[np.ndarray, float | None]:
    ffmpeg_bin = "/usr/bin/ffmpeg" if os.path.exists("/usr/bin/ffmpeg") else "ffmpeg"
    ffprobe_bin = "/usr/bin/ffprobe" if os.path.exists("/usr/bin/ffprobe") else "ffprobe"
    probed_dur = None
    try:
        out = subprocess.run(
            [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        probed_dur = float(out)
    except Exception:
        probed_dur = None

    p = subprocess.run(
        [
            ffmpeg_bin, "-nostdin", "-v", "error", "-i", str(path),
            "-vn", "-ac", "1", "-ar", str(SR), "-t", str(MAX_S), "-f", "f32le", "-",
        ],
        capture_output=True,
        check=True,
    )
    return np.frombuffer(p.stdout, dtype=np.float32), probed_dur


def _pct(x: np.ndarray, q: float) -> float:
    return float(np.percentile(x, q))


def _movavg(x: np.ndarray, size: int) -> np.ndarray:
    h = size // 2
    cs = np.cumsum(np.insert(np.pad(x, h, mode="symmetric"), 0, 0.0))
    return (cs[size:] - cs[:-size]) / size


def analyze_signal_djvibes(y: np.ndarray) -> tuple[dict, dict]:
    """Ported directly from BillTribble/DJ-Vibes dsp_models.analyze_signal."""
    n = len(y)
    f: dict[str, float] = {"dur_s": n / SR}
    w = int(0.4 * SR)
    k = n // w
    if k < 6:
        raise ValueError("track too short")
    rms = np.sqrt(np.mean(y[: k * w].reshape(k, w) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    f.update(
        db_mean=float(db.mean()),
        db_p10=_pct(db, 10),
        db_p50=_pct(db, 50),
        db_p90=_pct(db, 90),
        db_range=_pct(db, 95) - _pct(db, 10),
        db_std=float(db.std()),
        peak_db=float(20 * np.log10(np.abs(y).max() + 1e-9)),
    )
    lw = int(30 / 0.4)
    if k > lw:
        cs = np.cumsum(np.insert(db, 0, 0))
        f["db_peak30"] = float(((cs[lw:] - cs[:-lw]) / lw).max())
    else:
        f["db_peak30"] = float(db.mean())
    f["frac_loud"] = float(np.mean(db > _pct(db, 50)))
    f["db_top_gap"] = f["db_p90"] - f["db_p50"]

    nfr = 1 + (n - NFFT) // HOP
    if nfr < 60:
        raise ValueError("track too short")
    freqs = np.fft.rfftfreq(NFFT, 1 / SR)
    win = np.hanning(NFFT).astype(np.float32)
    bandm = [(name, (freqs >= lo) & (freqs < hi)) for name, lo, hi in BANDS]
    envm = [(name, (freqs >= lo) & (freqs < hi)) for name, lo, hi in ENV_BANDS]
    acc: dict[str, list[np.ndarray]] = {k_: [] for k_ in ("cen", "roll", "flat", "tot", "flux", "kick")}
    band_l: dict[str, list[np.ndarray]] = {name: [] for name, _ in bandm}
    env_l: dict[str, list[np.ndarray]] = {name: [] for name, _ in envm}
    prev = None
    for s0 in range(0, nfr, 512):
        e0 = min(nfr, s0 + 512)
        idx = np.arange(NFFT)[None, :] + HOP * np.arange(s0, e0)[:, None]
        S = np.abs(np.fft.rfft(y[idx] * win, axis=1)).astype(np.float32)
        P = S ** 2 + 1e-12
        tot = P.sum(1)
        acc["tot"].append(tot)
        acc["cen"].append((P * freqs).sum(1) / tot)
        acc["roll"].append(freqs[((np.cumsum(P, axis=1) / tot[:, None]) >= 0.85).argmax(1)])
        acc["flat"].append(np.exp(np.mean(np.log(P), 1)) / np.mean(P, 1))
        for name, m in bandm:
            band_l[name].append(P[:, m].sum(1))
        L = np.log1p(10 * S)
        d = np.maximum(0, np.diff(L if prev is None else np.vstack([prev, L]), axis=0))
        acc["flux"].append(d.sum(1))
        acc["kick"].append(d[:, envm[0][1]].sum(1))
        for name, m in envm:
            env_l[name].append(d[:, m].sum(1))
        prev = L[-1:]

    cat = {k_: np.concatenate(v) for k_, v in acc.items()}
    cen, roll, flat, tot, flux, kick = (cat[k_] for k_ in ("cen", "roll", "flat", "tot", "flux", "kick"))
    f.update(cent_mean=float(cen.mean()), cent_p90=_pct(cen, 90), cent_std=float(cen.std()))
    f["rolloff_mean"] = float(roll.mean())
    f["flatness_mean"] = float(flat.mean())
    f["zcr"] = float(np.mean(np.abs(np.diff(np.signbit(y).astype(np.int8)))))
    bands = {}
    for name, _ in bandm:
        bd = bands[name] = np.concatenate(band_l[name])
        f[f"band_{name}_frac"] = float(np.mean(bd / tot))
        f[f"band_{name}_db"] = float(10 * np.log10(bd.mean() + 1e-12))
    f["bass_to_high"] = f["band_sub_db"] - f["band_high_db"]
    f.update(flux_mean=float(flux.mean()), flux_std=float(flux.std()), flux_p90=_pct(flux, 90))
    f.update(kick_flux_mean=float(kick.mean()), kick_flux_p90=_pct(kick, 90))
    thr = flux.mean() + 0.5 * flux.std()
    pk = (flux[1:-1] > flux[:-2]) & (flux[1:-1] >= flux[2:]) & (flux[1:-1] > thr)
    f["onset_rate"] = float(pk.sum() / (len(flux) / FPS))
    kt = kick.mean() + 0.5 * kick.std()
    kp = (kick[1:-1] > kick[:-2]) & (kick[1:-1] >= kick[2:]) & (kick[1:-1] > kt)
    f["kick_rate"] = float(kp.sum() / (len(kick) / FPS))
    o = flux - flux.mean()
    nf = 1 << (2 * len(o) - 1).bit_length()
    ac = np.fft.irfft(np.abs(np.fft.rfft(o, nf)) ** 2)[: len(o)]
    ac = ac / (ac[0] + 1e-9)
    lo_l, hi_l = int(FPS * 60 / 200), min(len(ac) - 1, int(FPS * 60 / 60))
    seg = ac[lo_l:hi_l] if hi_l > lo_l else np.array([0.0])
    f["pulse_clarity"] = float(seg.max()) if len(seg) else 0.0
    f["bpm_est"] = float(60 * FPS / (lo_l + int(seg.argmax()))) if len(seg) else 120.0

    env: dict = {"full": flux.astype(np.float32)}
    env.update({name: np.concatenate(v).astype(np.float32) for name, v in env_l.items()})
    nw = len(flux) // WIN_ROWS
    wm = lambda x: x[: nw * WIN_ROWS].reshape(nw, WIN_ROWS).mean(1)
    pkf, kpf = np.zeros(len(flux)), np.zeros(len(kick))
    pkf[1:-1], kpf[1:-1] = pk, kp
    if nw > 0:
        cols = {
            "db": 10 * np.log10(wm(tot) + 1e-12),
            "cen": wm(cen),
            "flat": wm(flat),
            "flux": wm(flux),
            "kick": wm(kick),
            "onsets": wm(pkf) * FPS,
            "kicks": wm(kpf) * FPS,
        }
        cols.update({name: wm(bands[name] / tot) for name in bands})
        ys = np.abs(y[: nw * WIN_ROWS * HOP]).reshape(nw, WIN_ROWS * HOP)
        cols["peak_db"] = 20 * np.log10(ys.max(1) + 1e-9)
        cols["clip"] = (ys >= CLIP_LEVEL).mean(1)
        env["win"] = np.stack([cols[c] for c in WIN_COLS], 1).astype(np.float32)
        w_arr = env["win"].astype(np.float64)
        peak_c, db_c, clip_c = w_arr[:, WIN_COLS.index("peak_db")], w_arr[:, 0], w_arr[:, WIN_COLS.index("clip")]
        f.update(
            clip_mean=float(clip_c.mean()),
            clip_p90=float(np.percentile(clip_c, 90)),
            crest_mean=float((peak_c - db_c).mean()),
            peak_p90=float(np.percentile(peak_c, 90)),
        )
    else:
        env["win"] = np.zeros((0, len(WIN_COLS)), dtype=np.float32)
        f.update(clip_mean=0.0, clip_p90=0.0, crest_mean=0.0, peak_p90=-90.0)

    env["frames"] = {
        "tot": tot,
        "flux": flux,
        "kick": kick,
        "sub_frac": bands["sub"] / tot,
        "bass_frac": bands["bass"] / tot,
        "mid_frac": bands["mid"] / tot,
        "high_frac": bands["high"] / tot,
    }
    return f, env


def predict_energy_djvibes(feats: dict, p: dict) -> int:
    m = p["energy"]
    x = np.array([feats[n] for n in m["features"]], float)
    score = float(((x - np.array(m["mu"])) / np.array(m["sd"])) @ np.array(m["w"]) + m["b"])
    cuts = m.get("cuts")
    if not cuts:
        return int(np.clip(np.rint(score), 1, 10))
    return int(np.clip(1 + np.searchsorted(np.asarray(cuts, float), score, side="right"), 1, 10))


def segment_scores_djvibes(win: np.ndarray, p: dict) -> np.ndarray:
    if len(win) == 0 or "segment_energy" not in p:
        return np.array([], dtype=np.float64)
    m = p["segment_energy"]
    w = np.asarray(win, np.float64)
    c = {n: w[:, i] for i, n in enumerate(m["win_cols"])}
    lf = np.log(c["flux"] + 1e-3)
    c.update(
        log_flux=lf,
        log_kick=np.log(c["kick"] + 1e-3),
        log_cen=np.log(c["cen"] + 1.0),
        db_rel=c["db"] - c["db"].mean(),
        onsets_rel=c["onsets"] - c["onsets"].mean(),
        flux_rel=lf - lf.mean(),
    )
    F = np.column_stack([c[n] for n in m["features"]])
    X = np.hstack([F] + [np.maximum(0, F - np.asarray(q)) for q in m["knots"]])
    return ((X - np.asarray(m["mu"])) / np.asarray(m["sd"])) @ np.asarray(m["coef"]) + m["intercept"]


def prepare_and_coarse_bpm(env: dict, theta: list[float]) -> tuple[list[np.ndarray], float, float]:
    global _GRID_BPM, _GRID_LAGS
    if _GRID_BPM is None:
        _GRID_BPM = np.arange(50.0, 220.0, 0.25)
        _GRID_LAGS = np.arange(LMAX + 1, dtype=float)
    xs = []
    for b in ("low", "mid", "high"):
        x = env[b].astype(np.float64)
        x = np.maximum(0, x - _movavg(x, int(FPS)))
        xs.append(x / (x.std() + 1e-9))
    n = len(xs[0])
    nf = 1 << (2 * n).bit_length()
    F = [np.fft.rfft(x, nf) for x in xs]
    lmax_eff = min(LMAX, nf // 2 - 1)
    C = np.zeros((3, 3, LMAX + 1))
    for i in range(3):
        for j in range(3):
            C[i, j, : lmax_eff + 1] = np.fft.irfft(np.conj(F[i]) * F[j])[: lmax_eff + 1] / n
    w = np.asarray(theta[:3])
    ac = np.einsum("i,j,ijl->l", w, w, C)
    ac = ac / (ac[0] + 1e-12)
    L = 60 * FPS / _GRID_BPM
    v = lambda k: np.interp(k * L, _GRID_LAGS, ac, right=0.0)
    score = v(1) + theta[3] * v(0.5) + theta[4] * v(2) + theta[5] * v(3) + theta[6] * v(4)
    score = score * np.exp(-0.5 * ((np.log2(_GRID_BPM) - theta[7]) / theta[8]) ** 2)
    k = int(np.argmax(score))
    ratio = 0.0
    if _GRID_BPM[k] / 2 >= 50 and score[k] > 0:
        kh = int(np.argmin(np.abs(_GRID_BPM - _GRID_BPM[k] / 2)))
        ratio = float(max(score[max(kh - 2, 0) : kh + 3].max(), 0) / score[k])
    if 0 < k < len(_GRID_BPM) - 1:
        a, b_val, c_val = score[k - 1], score[k], score[k + 1]
        d = (a - c_val) / (2 * (a - 2 * b_val + c_val)) if (a - 2 * b_val + c_val) != 0 else 0
        bpm_est = float(_GRID_BPM[k] + 0.25 * np.clip(d, -1, 1))
    else:
        bpm_est = float(_GRID_BPM[k])
    return xs, bpm_est, ratio


def adjust_dnb_tempo(bpm: float, genre_text: str) -> tuple[float, bool]:
    """Ported from BillTribble/DJ-Vibes genre_tempo.adjust (bd-4cj, bd-3cz)."""
    if not bpm or not _DNB_RE.search(genre_text or ""):
        return bpm, False
    new = float(bpm)
    for _ in range(2):
        if new < 100.0:
            new *= 2.0
    if 105.0 <= new < 120.0:
        new *= 1.5
    for _ in range(2):
        if new > 200.0:
            new /= 2.0
    return new, abs(new - float(bpm)) > 1e-6


def fine_fit_djvibes(xs: list[np.ndarray], theta: list[float], bpm0: float, search: bool = True, nbins: int = 96) -> tuple[float, float, float]:
    """Ported from BillTribble/DJ-Vibes dsp_models.fine_fit (+12ms ONSET_LAG_S transient lock)."""
    s = sum(w * x for w, x in zip(theta[:3], xs))
    idx = np.arange(len(s), dtype=float)
    cands = bpm0 * (1 + np.linspace(-0.03, 0.03, 301)) if search else [bpm0]
    best = (-1.0, bpm0, 0.0)
    for bpm in cands:
        P = 60 * FPS / bpm
        ph = ((idx % P) / P * nbins).astype(int) % nbins
        h = np.bincount(ph, weights=s, minlength=nbins)
        h3 = h + np.roll(h, 1) + np.roll(h, -1)
        sc = float(h3.max() / (h.sum() + 1e-9))
        if sc > best[0]:
            best = (sc, float(bpm), ((int(h3.argmax()) + 0.5) / nbins) * P)
    sc, bpm, ph_frames = best
    P = 60 * FPS / bpm
    phases = (idx % P) / P
    wgt = s * (np.abs(((phases - ph_frames / P + 0.5) % 1) - 0.5) < 0.04)
    mean_ph = (np.angle((wgt * np.exp(2j * np.pi * phases)).sum()) / (2 * np.pi)) % 1 if wgt.sum() > 0 else ph_frames / P
    first = (T_OFF + ONSET_LAG_S + mean_ph * P / FPS) % (60.0 / bpm)
    return float(bpm), float(first), float(sc)


def analyze_beatgrid_and_groove(
    track: dict,
    drop_rec: dict,
    feats: dict,
    env: dict,
    seg_scores: np.ndarray,
    bpm: float,
    first_beat_sec: float,
    grid_peakiness: float,
    energy_dj: int,
    full_dur: float,
) -> dict:
    """Extracts bar_offset (0..3), phrase_bar (0..3), groove ('4x4'|'broken'|'ambient'), cue_in_sec, mix_out_sec."""
    beat_sec = 60.0 / max(45.0, bpm)
    bar_sec = 4.0 * beat_sec
    fr = env["frames"]
    kick_env = fr["kick"].astype(np.float64)
    mid_env = env["mid"].astype(np.float64)
    tot_env = fr["tot"].astype(np.float64)
    sub_frac = fr["sub_frac"].astype(np.float64)
    high_frac = fr["high_frac"].astype(np.float64)

    analyzed_dur = float(feats["dur_s"])
    n_frames = len(kick_env)

    # Sample kick & snare energy on a 16-substep-per-bar (1/16th note) grid
    substep_sec = beat_sec / 4.0
    substep_times = np.arange(first_beat_sec, analyzed_dur - 0.02, substep_sec)
    n_bars_16 = len(substep_times) // 16

    bar_offset = 0
    phrase_bar = 0
    onbeat_kick_ratio = 0.25
    min_max_beat_kick = 0.0
    beat_kick_hit_rate = 0.0

    if n_bars_16 >= 4:
        substep_times = substep_times[: n_bars_16 * 16]
        frame_idx = np.clip(np.round((substep_times - T_OFF) * FPS).astype(int), 0, n_frames - 1)
        # Take local 3-frame max (~70ms window around grid point) to tolerate slight swing/micro-timing
        idx_m1 = np.maximum(0, frame_idx - 1)
        idx_p1 = np.minimum(n_frames - 1, frame_idx + 1)
        k_grid = np.maximum(kick_env[frame_idx], np.maximum(kick_env[idx_m1], kick_env[idx_p1])).reshape(n_bars_16, 16)
        m_grid = np.maximum(mid_env[frame_idx], np.maximum(mid_env[idx_m1], mid_env[idx_p1])).reshape(n_bars_16, 16)
        tot_grid = tot_env[frame_idx].reshape(n_bars_16, 16)
        sub_grid = sub_frac[frame_idx].reshape(n_bars_16, 16)

        # Restrict groove rhythm statistics to active bars (top 65% by energy) so beatless intros/outros don't skew
        bar_tot = tot_grid.mean(axis=1)
        active_thr = np.percentile(bar_tot, 35)
        active_mask = bar_tot >= active_thr
        k_act = k_grid[active_mask] if active_mask.sum() >= 3 else k_grid
        m_act = m_grid[active_mask] if active_mask.sum() >= 3 else m_grid

        # 1. Quarter-note on-beat vs 16th/8th off-beat kick concentration
        sub4 = k_act.reshape(-1, 4).mean(axis=0)  # [on-beat, 16th, 8th, 16th]
        onbeat_kick_ratio = float(sub4[0] / (sub4.sum() + 1e-9))

        # 2. Uniformity of kick across the 4 beats of a bar (0, 4, 8, 12)
        beat_kicks = k_act[:, [0, 4, 8, 12]]  # shape (n_active_bars, 4)
        mean_per_beat = beat_kicks.mean(axis=0)
        min_max_beat_kick = float(mean_per_beat.min() / (mean_per_beat.max() + 1e-9))

        kick_hit_thr = max(1.6, float(np.percentile(k_act, 65)) * 0.72)
        beat_kick_hit_rate = float((beat_kicks > kick_hit_thr).mean())

        # 3. Downbeat (`bar_offset` in 0..3): Beat 1 accent + bass shift + backbeat snare on beats 2 & 4
        all_beats_k = k_grid.reshape(-1, 4)[:, 0]
        all_beats_m = m_grid.reshape(-1, 4)[:, 0]
        all_beats_sub = sub_grid.reshape(-1, 4).mean(axis=1)
        all_beats_tot = np.log1p(tot_grid.reshape(-1, 4).mean(axis=1))
        novelty_beat = np.abs(np.diff(all_beats_tot, prepend=all_beats_tot[0])) + 2.0 * np.abs(
            np.diff(all_beats_sub, prepend=all_beats_sub[0])
        )

        has_drop_flag = bool(drop_rec.get("has_drop") or track.get("has_drop"))
        drop_sec = float(drop_rec.get("drop_sec") or drop_rec.get("t_drop") or track.get("drop_sec") or 0.0) if has_drop_flag else 0.0
        best_b_score = -1e9
        for b in range(4):
            nb_bars = (len(all_beats_k) - b) // 4
            if nb_bars < 2:
                continue
            sl_b = all_beats_k[b : b + nb_bars * 4].reshape(nb_bars, 4)
            sl_m = all_beats_m[b : b + nb_bars * 4].reshape(nb_bars, 4)
            sl_nov = novelty_beat[b : b + nb_bars * 4].reshape(nb_bars, 4)
            score_b = (
                1.0 * float(sl_b[:, 0].mean())
                + 0.45 * float(sl_m[:, 1].mean() + sl_m[:, 3].mean())
                + 0.90 * float(sl_nov[:, 0].mean())
            )
            if drop_sec > beat_sec * 4:
                beat_idx_at_drop = int(round((drop_sec - first_beat_sec) / beat_sec))
                if beat_idx_at_drop >= 0 and (beat_idx_at_drop % 4) == b:
                    score_b *= 1.18
            if score_b > best_b_score:
                best_b_score = score_b
                bar_offset = b

        # 4. 4-Bar Phrase (`phrase_bar` in 0..3 from `first_bar_sec`)
        all_beats_tot_after = all_beats_tot[bar_offset:]
        all_beats_high = high_frac[frame_idx].reshape(-1, 4).mean(axis=1)[bar_offset:]
        n_full_bars = len(all_beats_tot_after) // 4
        if n_full_bars >= 8:
            bar_loud = all_beats_tot_after[: n_full_bars * 4].reshape(n_full_bars, 4).mean(axis=1)
            bar_hi = all_beats_high[: n_full_bars * 4].reshape(n_full_bars, 4).mean(axis=1)
            bar_nov = np.abs(np.diff(bar_loud, prepend=bar_loud[0])) + 1.5 * np.abs(
                np.diff(bar_hi, prepend=bar_hi[0])
            )
            best_p_score = -1e9
            first_bar_s = first_beat_sec + bar_offset * beat_sec
            for p_off in range(4):
                vals = bar_nov[p_off::4]
                sc_p = float(vals.mean()) if len(vals) else 0.0
                if drop_sec > bar_sec * 2:
                    bar_idx_at_drop = int(round((drop_sec - first_bar_s) / bar_sec))
                    if bar_idx_at_drop >= 0 and (bar_idx_at_drop % 4) == p_off:
                        sc_p *= 1.30
                if sc_p > best_p_score:
                    best_p_score = sc_p
                    phrase_bar = p_off

    # Normalize beat clarity to [0, 1] combining DJ-Vibes fine_fit peakiness + pulse_clarity + quarter kick lock
    raw_peak_norm = min(1.0, grid_peakiness / 0.14)
    beat_clarity = float(
        np.clip(0.50 * raw_peak_norm + 0.30 * float(feats.get("pulse_clarity", 0.0)) + 0.20 * min(1.0, onbeat_kick_ratio * 2.0), 0.0, 1.0)
    )

    # ---- 3-Way Groove Classification: "4x4" | "broken" | "ambient" ----
    cluster_id = str(track.get("cluster_id") or "")
    cluster_label = str(track.get("cluster_label") or "")
    rhythm_tag = str(track.get("rhythm_tag") or "")
    groove_style = str(track.get("groove_style") or "")
    fof_cat = float(track.get("four_on_floor") or 0.0)
    brk_cat = float(track.get("breakbeat_score") or 0.0)
    perc_share = float(track.get("perc_share") or 0.0)
    has_drums_gate = drop_rec.get("has_drums")
    if has_drums_gate is None:
        has_drums_gate = perc_share >= 0.065 or feats.get("kick_rate", 0.0) >= 1.2

    is_spoken = bool(track.get("is_spoken_word"))
    is_dnb = bool(
        cluster_id == "d7_dnb_breaks"
        or "Drum & bass" in cluster_label
        or rhythm_tag == "Fast D&B / jungle breaks"
        or bpm >= 155.0
    )
    is_uk_bass_or_breaks_cluster = bool(
        cluster_id in BROKEN_CLUSTERS
        or "UK bass" in cluster_label
        or "IDM" in cluster_label
    )

    if (
        is_spoken
        or has_drums_gate is False
        or cluster_id in {"d0_ambient", "d10_dark_ambient"}
        or rhythm_tag in {"Beatless ambient wash", "Dark ambient drone", "Weightless ambient drift"}
        or (rhythm_tag in AMBIENT_RHYTHM_TAGS and fof_cat < 35.0 and perc_share < 0.14)
        or (groove_style in {"ambient", "dark_ambient", "guitar_demo", "guitar_vocal"} and fof_cat < 30.0 and perc_share < 0.14)
        or (perc_share < 0.055 and feats.get("kick_rate", 0.0) < 1.1)
    ):
        groove = "ambient"
    elif is_dnb:
        groove = "broken"
    elif is_uk_bass_or_breaks_cluster:
        # UK bass/dubstep/juke, IDM/glitch, and live indie rock kits default to "broken"
        # unless acoustic analysis & catalog both show an unambiguous steady 4-on-the-floor kick
        unmistakable_4x4 = (
            114.0 <= bpm <= 145.0
            and min_max_beat_kick >= 0.72
            and onbeat_kick_ratio >= 0.44
            and beat_kick_hit_rate >= 0.72
            and fof_cat >= 68.0
            and brk_cat < 35.0
            and cluster_id not in {"d7_dnb_breaks", "d9_uk_bass", "d4_indie_guitar"}
            and "UK bass" not in cluster_label
        )
        groove = "4x4" if unmistakable_4x4 else "broken"
    else:
        # Evaluate 4-on-the-floor regularity vs syncopated breakbeat feel
        dsp_4x4_score = (
            0.40 * min(1.0, min_max_beat_kick / 0.72)
            + 0.30 * min(1.0, max(0.0, (onbeat_kick_ratio - 0.22) / 0.24))
            + 0.20 * beat_kick_hit_rate
            + 0.10 * (fof_cat / 100.0)
        )
        if cluster_id in FOUR_FLOOR_CLUSTERS or "Afro, house" in cluster_label or rhythm_tag in {"Driven 4/4 house pulse", "Steady 4/4 pulse"}:
            dsp_4x4_score += 0.14
        if rhythm_tag == "Breakbeat / syncopated groove" or groove_style in {"breakbeat", "rock", "ambient_rock"}:
            dsp_4x4_score -= 0.14
        if brk_cat > fof_cat + 18.0:
            dsp_4x4_score -= 0.12

        if 88.0 <= bpm <= 152.0 and dsp_4x4_score >= 0.56 and min_max_beat_kick >= 0.44:
            groove = "4x4"
        else:
            groove = "broken"

    # ---- Cue-In (`cue_in_sec`), Audible End (`audible_end_sec`) & Mix-Out (`mix_out_sec`) ----
    is_psy = is_psychedailies_track(track)
    first_bar_sec = first_beat_sec + bar_offset * beat_sec
    first_phrase_sec = first_bar_sec + phrase_bar * bar_sec

    # Cue-in: Psychedailies & ambient tracks always fade in right from 0.0s (post-024688);
    # other rhythmic tracks find the first bar/phrase downbeat past dead silence.
    win_arr = env["win"]
    cue_in_sec = 0.0 if (is_psy or groove == "ambient") else round(first_bar_sec, 3)
    if not is_psy and groove != "ambient" and len(win_arr) >= 4:
        win_db = win_arr[:, 0]
        body_db = float(np.percentile(win_db, 80))
        audible_win = np.flatnonzero(win_db >= body_db - 20.0)
        earliest_audible_s = float(audible_win[0] * WIN_S) if len(audible_win) else 0.0
        max_intro_s = min(24.0, max(bar_sec * 2.0, 0.18 * full_dur))
        target_s = min(max_intro_s, max(0.0, earliest_audible_s))
        # Snap forward to nearest bar downbeat (preferring phrase downbeat if within 1 bar)
        if target_s <= first_bar_sec + 0.05:
            cue_in_sec = round(first_bar_sec, 3)
        else:
            m_bar = max(0, int(math.ceil((target_s - first_bar_sec - 0.08) / bar_sec)))
            cand_bar = first_bar_sec + m_bar * bar_sec
            # If next 4-bar phrase downbeat is <= 1 bar away and still <= max_intro_s, snap to phrase!
            rem_to_phrase = (phrase_bar - (m_bar % 4)) % 4
            if rem_to_phrase == 1 and (cand_bar + bar_sec) <= max_intro_s + 0.5:
                cand_bar += bar_sec
            cue_in_sec = round(min(cand_bar, max(0.0, full_dur - 8.0)), 3)

    # Audible end: detect trailing silence / near-silence across `full_dur` (post-024701)
    audible_end = compute_audible_end_sec(track, full_dur)

    bpm_out = round(bpm, 2)
    fb_out = round(first_beat_sec, 4)
    beat_sec_out = 60.0 / bpm_out
    bar_sec_out = 4.0 * beat_sec_out
    phrase_sec_out = 4.0 * bar_sec_out
    first_bar_out = fb_out + int(bar_offset) * beat_sec_out
    first_phrase_out = first_bar_out + int(phrase_bar) * bar_sec_out

    def _calc_phrase_fade_sec() -> float:
        res_pf = max(1.8, 1.5 * bar_sec_out)
        hard_pf = audible_end - max(1.2, 1.1 * bar_sec_out)
        target_pf = min(hard_pf, audible_end - res_pf)
        max_p_pf = int(math.floor((hard_pf - first_phrase_out) / phrase_sec_out))
        if max_p_pf >= 1:
            p_i = int(math.floor((target_pf - first_phrase_out) / phrase_sec_out))
            p_i = max(1, min(p_i, max_p_pf))
            while p_i < max_p_pf and (first_phrase_out + p_i * phrase_sec_out) < cue_in_sec + bar_sec_out:
                p_i += 1
            return round(first_phrase_out + p_i * phrase_sec_out, 4)
        return round(max(0.0, audible_end - max(1.8, bar_sec_out)), 3)

    if is_psy:
        mix_out_sec = compute_psychedailies_tail_mixout(audible_end, groove, bpm_out, fb_out, int(bar_offset))
        phrase_fade_sec = mix_out_sec
    elif groove == "4x4":
        # Reserve >= 5.2 bars (~10s) of solid audio before audible_end for the 5-bar DJ blend
        reserve_sec = max(8.5, 5.2 * bar_sec_out)
        hard_max = audible_end - max(1.8, 2.2 * bar_sec_out)
        target_mix_max = min(hard_max, audible_end - reserve_sec)
        max_p_hard = int(math.floor((hard_max - first_phrase_out) / phrase_sec_out))
        if max_p_hard >= 1:
            p_idx = int(math.floor((target_mix_max - first_phrase_out) / phrase_sec_out))
            p_idx = max(1, min(p_idx, max_p_hard))
            while p_idx < max_p_hard and (first_phrase_out + p_idx * phrase_sec_out) < cue_in_sec + bar_sec_out:
                p_idx += 1
            mix_out_sec = round(first_phrase_out + p_idx * phrase_sec_out, 4)
        else:
            mix_out_sec = round(max(0.0, audible_end - min(8.0, 0.35 * audible_end)), 3)
        phrase_fade_sec = _calc_phrase_fade_sec()
    elif groove == "broken":
        # Broken-beat tracks always trigger strictly at the end of a 4-bar phrase section (`first_phrase_out + p_idx * 4 * bar_sec`),
        # reserving >= 1.5 bars before audible_end for the smooth 1-bar beat-synced fade!
        mix_out_sec = _calc_phrase_fade_sec()
        phrase_fade_sec = mix_out_sec
    else:
        fade_amb = 2.4 if (full_dur - audible_end >= 1.5) else 1.65
        mix_out_sec = round(max(0.5, min(audible_end - fade_amb, max(0.5, full_dur - 1.5))), 3)
        phrase_fade_sec = mix_out_sec

    return {
        "bpm": bpm_out,
        "first_beat_sec": fb_out,
        "bar_offset": int(bar_offset),
        "phrase_bar": int(phrase_bar),
        "beat_clarity": round(beat_clarity, 3),
        "energy_dj": int(energy_dj),
        "groove": groove,
        "cue_in_sec": cue_in_sec,
        "audible_end_sec": round(audible_end, 3),
        "mix_out_sec": mix_out_sec,
        "phrase_fade_sec": phrase_fade_sec,
    }


def process_one_track(args_tuple: tuple[dict, dict, str, str]) -> tuple[str, dict]:
    track, drop_rec, cache_dir_str, params_path_str = args_tuple
    tid = str(track["id"])
    p = get_params(Path(params_path_str))
    theta = p["bpm"]["theta"]

    cat_bpm = float(track.get("bpm") or track.get("effective_bpm") or 120.0)
    full_dur = float(track.get("full_duration_sec") or track.get("duration_sec") or 0.0)

    try:
        audio_path = ensure_local_audio(track, Path(cache_dir_str))
        y, probed_dur = decode_audio_djvibes(audio_path)
        if probed_dur and probed_dur > full_dur:
            full_dur = probed_dur
        elif full_dur <= 0.0:
            full_dur = len(y) / SR

        feats, env = analyze_signal_djvibes(y)
        energy_dj = predict_energy_djvibes(feats, p)
        seg_scores = segment_scores_djvibes(env["win"], p)
        xs, bpm_raw, half_ratio = prepare_and_coarse_bpm(env, theta)

        if tid in BPM_OVERRIDES:
            bpm_fit, first_beat_sec, peakiness = fine_fit_djvibes(
                xs, theta, float(BPM_OVERRIDES[tid]), search=False
            )
        else:
            rhythm_tag_raw = str(track.get("rhythm_tag") or "")
            # Ignore stale "Fast D&B" rhythm_tag when cat_bpm hit the 198.77 ceiling lag in non-DnB clusters
            effective_rhythm_tag = (
                ""
                if (cat_bpm >= 195.0 and str(track.get("cluster_id") or "") != "d7_dnb_breaks")
                else rhythm_tag_raw
            )
            genre_bits = [
                str(track.get("cluster_id") or ""),
                str(track.get("cluster_label") or ""),
                effective_rhythm_tag,
                " ".join(str(x) for x in (track.get("discogs_styles") or [])),
            ]
            genre_text = " | ".join(genre_bits)

            bpm_dnb, was_dnb = adjust_dnb_tempo(bpm_raw, genre_text)
            if was_dnb or _DNB_RE.search(genre_text):
                bpm0 = bpm_dnb if bpm_dnb >= 135.0 else (bpm_dnb * 2.0 if bpm_dnb < 100.0 else bpm_dnb)
            else:
                cluster_id = str(track.get("cluster_id") or "")
                cluster_label = str(track.get("cluster_label") or "")
                rhythm_tag = effective_rhythm_tag
                is_dance_4x4_prior = (
                    cluster_id in FOUR_FLOOR_CLUSTERS
                    or "Afro, house" in cluster_label
                    or rhythm_tag in {"Driven 4/4 house pulse", "Steady 4/4 pulse"}
                )
                if is_dance_4x4_prior and 108.0 <= bpm_raw <= 150.0:
                    bpm0 = bpm_raw
                elif is_dance_4x4_prior and 54.0 <= bpm_raw <= 75.0:
                    bpm0 = bpm_raw * 2.0
                else:
                    halved = bpm_raw / 2 >= 50.0 and (energy_dj < 4 or half_ratio > theta[9])
                    bpm0 = bpm_raw / 2.0 if halved else bpm_raw
                    # Keep rhythmic electronic tracks in standard 84..176 DJ tempo octave when catalog agrees
                    if bpm0 < 82.0 and 108.0 <= cat_bpm <= 176.0 and abs(bpm0 * 2.0 - cat_bpm) / cat_bpm <= 0.08:
                        bpm0 *= 2.0

            bpm_fit, first_beat_sec, peakiness = fine_fit_djvibes(xs, theta, bpm0, search=True)

        entry = analyze_beatgrid_and_groove(
            track=track,
            drop_rec=drop_rec,
            feats=feats,
            env=env,
            seg_scores=seg_scores,
            bpm=bpm_fit,
            first_beat_sec=first_beat_sec,
            grid_peakiness=peakiness,
            energy_dj=energy_dj,
            full_dur=full_dur,
        )
        if tid in BEATGRID_OVERRIDES:
            entry.update(BEATGRID_OVERRIDES[tid])
        return tid, entry
    except Exception:
        # Clean fallback from catalog fields if decode fails or clip is extremely short
        bpm_fb = round(float(BPM_OVERRIDES.get(tid) or cat_bpm or 120.0), 2)
        beat_s = 60.0 / bpm_fb
        bar_s = 4.0 * beat_s
        fb_s = round(float(track.get("beat_phase_sec") or 0.0) % beat_s, 4)
        groove_fb = "ambient" if track.get("is_spoken_word") else (
            "4x4" if str(track.get("groove_style")) == "four_on_floor" else "broken"
        )
        aud_fb = compute_audible_end_sec(track, full_dur)
        if is_psychedailies_track(track):
            mo_fb = compute_psychedailies_tail_mixout(aud_fb, groove_fb, bpm_fb, fb_s, 0)
            pf_fb = mo_fb
        else:
            mo_fb = round(max(0.0, aud_fb - 5.0 * bar_s), 3)
            pf_fb = round(max(0.0, aud_fb - 2.0 * bar_s), 3)
        fb_entry = {
            "bpm": bpm_fb,
            "first_beat_sec": fb_s,
            "bar_offset": 0,
            "phrase_bar": 0,
            "beat_clarity": round(float(track.get("pulse_clarity") or 0.35), 3),
            "energy_dj": int(track.get("energy") or 5),
            "groove": groove_fb,
            "cue_in_sec": 0.0,
            "audible_end_sec": aud_fb,
            "mix_out_sec": mo_fb,
            "phrase_fade_sec": pf_fb,
        }
        if tid in BEATGRID_OVERRIDES:
            fb_entry.update(BEATGRID_OVERRIDES[tid])
        return tid, fb_entry


def write_beatgrids_js(out_js_path: Path, grids: dict[str, dict]) -> None:
    ordered = {k: grids[k] for k in sorted(grids.keys())}
    body = json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)
    header = (
        "// Offline DJ Beat-Grids, Downbeats, 4-Bar Phrase Offsets & Groove Classification\n"
        "// Generated by scripts/build_beatgrids.py via BillTribble/DJ-Vibes DSP pipeline.\n"
        "window.BEAT_GRIDS = window.MUSIC_MAP_BEATGRIDS = "
    )
    out_js_path.write_text(header + body + ";\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build offline js/beatgrids.js using DJ-Vibes DSP pipeline.")
    ap.add_argument("--data-js", type=Path, default=DEFAULT_DATA_JS)
    ap.add_argument("--drop-json", type=Path, default=DEFAULT_DROP_JSON)
    ap.add_argument("--params-json", type=Path, default=DEFAULT_PARAMS_JSON)
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    ap.add_argument("--out-js", type=Path, default=DEFAULT_OUT_JS)
    ap.add_argument("--workers", type=int, default=max(2, min(16, (os.cpu_count() or 4))))
    args = ap.parse_args()

    t0 = time.time()
    tracks = load_corpus_tracks(args.data_js)
    drop_map: dict[str, dict] = {}
    if args.drop_json.exists():
        raw_dp = json.loads(args.drop_json.read_text(encoding="utf-8"))
        drop_map = raw_dp.get("tracks", raw_dp) if isinstance(raw_dp, dict) else {}

    work = [(t, drop_map.get(str(t["id"]), {}), str(args.cache_dir), str(args.params_json)) for t in tracks]
    print(f"Analyzing {len(work)} tracks with DJ-Vibes pipeline ({args.workers} workers)...")

    grids: dict[str, dict] = {}
    ctx = multiprocessing.get_context("spawn")
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, mp_context=ctx) as pool:
        futs = [pool.submit(process_one_track, item) for item in work]
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            tid, res = fut.result()
            grids[tid] = res
            if idx % 100 == 0 or idx == len(work):
                print(f"  [{idx}/{len(work)}] analyzed ({time.time() - t0:.1f}s)")

    write_beatgrids_js(args.out_js, grids)
    groove_counts = Counter(g["groove"] for g in grids.values())
    by_cluster: dict[str, Counter] = defaultdict(Counter)
    for t in tracks:
        cl = f"{t.get('cluster_id')}:{t.get('cluster_label')}"
        by_cluster[cl][grids[str(t["id"])]["groove"]] += 1

    print(f"\nWrote {len(grids)} beat-grids to {args.out_js} ({args.out_js.stat().st_size / 1024:.1f} KB) in {time.time() - t0:.1f}s")
    print("Groove totals:", dict(groove_counts))
    for cl in sorted(by_cluster.keys()):
        print(f"  {cl:52s} -> {dict(by_cluster[cl])}")


if __name__ == "__main__":
    main()

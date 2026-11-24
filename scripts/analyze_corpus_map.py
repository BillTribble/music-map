#!/usr/bin/env python3
"""Mixed In Key + DSP Macro Harmonic & Drum Analysis + Similarity/Era Node Map Generator.

Reads full source masters (never mutating original files) to extract:
1. MIK Energy (1-10) via Collection10.mikdb / ID3 tags / mik_analyze.py (staged) / DJVibes calibrated MIK model.
2. Accurate BPM & Camelot Key (Krumhansl-Schmuckler on Harmonic STFT chromagram or MIK).
3. Macro Harmonic Complexity (0-100): chord richness, harmonic motion, modal darkness, microtonal shimmer.
4. Drum & Rhythm Complexity (0-100): percussive share, onset density, off-beat syncopation/entropy, 4/4 pulse clarity.
5. Agglomerative style clustering + t-SNE 2D similarity coordinates + 16-Era chronological layout.

Usage:
  /opt/homebrew/anaconda3/bin/python scripts/analyze_corpus_map.py \
      --corpus-root "<corpus>" --archive-root "<archive>"
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter
from sklearn.cluster import AgglomerativeClustering
from sklearn.manifold import TSNE
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
import prepare_audio as pa  # noqa: E402

DJVIBES_DIR = Path.home() / "Sites" / "DJVibes"
sys.path.insert(0, str(DJVIBES_DIR))
import dsp_models  # noqa: E402

MIK_DB = Path.home() / "Library" / "Application Support" / "Mixedinkey" / "Collection10.mikdb"
MIK_SCRIPT = Path.home() / ".agents" / "skills" / "dj-spotify-pipeline" / "scripts" / "mik_analyze.py"

NOTE_PC_MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
NOTE_PC_MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm", "Am", "Bbm", "Bm"]
CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64)
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64)

ERA_ORDER = [
    "present_ambient",
    "present_electro",
    "hd_2005",
    "bands_archive",
    "archive_2013_18",
    "nihon_forever",
    "ep_concepts",
    "le_garage",
    "psychedailies",
    "archive_2018_23",
    "spirit_guides",
    "lucid_crystal",
    "remixes_commissions",
    "sketches_2024_25",
    "ecstatic_wave",
    "sketches_2026",
]

# Archetype clues from project folders for BPM octave & fallback disambiguation only (features remain pure DSP/MIK)
DNB_HINTS = {"junglemassive", "fireworks", "fell in love", "serpentine", "remixes_commissions_1", "psychedailies_1", "psychedailies_3", "hd_2005_3"}


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return float(max(lo, min(hi, v)))


def decode_audio(ffmpeg_bin: str, src: Path, start_s: float = 0.0, dur_s: float = 240.0) -> np.ndarray:
    cmd = [ffmpeg_bin, "-nostdin", "-v", "error"]
    if start_s > 0:
        cmd += ["-ss", f"{start_s:.2f}"]
    cmd += ["-t", f"{dur_s:.2f}", "-i", str(src), "-vn", "-ac", "1", "-ar", str(dsp_models.SR), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def lookup_mik_db() -> dict[str, dict]:
    out = {}
    if not MIK_DB.exists():
        return out
    try:
        con = sqlite3.connect(f"file:{MIK_DB}?mode=ro", uri=True)
        for name, tempo, key, energy in con.execute("SELECT ZNAME, ZTEMPO, ZKEY, ZENERGY FROM ZSONG").fetchall():
            if name and energy is not None:
                k = "".join(c for c in name.lower() if c.isalnum())
                out[k] = {"tempo": tempo, "key": key, "energy": float(energy)}
        con.close()
    except Exception:
        pass
    return out


def read_mutagen_mik(path: Path) -> dict:
    try:
        import mutagen
        mf = mutagen.File(str(path), easy=False)
        if not mf or not mf.tags:
            return {}
        info = {}
        for k, v in mf.tags.items():
            ks = str(k)
            val = v.text[0] if hasattr(v, "text") and v.text else str(v)
            if "EnergyLevel" in ks:
                try:
                    info["energy"] = int(float(str(val).strip()))
                except Exception:
                    pass
            elif ks == "TKEY":
                info["key"] = str(val).strip()
            elif ks == "TBPM":
                try:
                    info["bpm"] = float(str(val).strip())
                except Exception:
                    pass
            elif ks.startswith("COMM") and "energy" not in info:
                import re
                m = re.match(r"^\s*([1-9]|10)\b", str(val))
                if m:
                    info["energy"] = int(m.group(1))
        return info
    except Exception:
        return {}


def can_run_mik_gui() -> bool:
    try:
        subprocess.run(["open", "-g", "-a", "System Events"], capture_output=True, timeout=4)
        r = subprocess.run(
            ["osascript", "-e", 'tell application "System Events" to count processes'],
            capture_output=True, text=True, timeout=6
        )
        return r.returncode == 0
    except Exception:
        return False


def compute_drum_complexity(perc_share: float, perc_onset_rate: float, gap_cv: float, gap_ent: float, high_low_ratio: float, breakbeat_score: float = 0.0) -> float:
    """Single canonical formula for 0..100 Drum Complexity, gating out beatless ambient washes."""
    s_perc = clamp(perc_share / 0.36 * 100.0)
    s_rate = clamp(perc_onset_rate / 7.5 * 100.0)
    s_sync = clamp((gap_cv / 1.15 * 50.0) + (clamp(gap_ent * 100.0, 0.0, 100.0) * 0.50))
    s_hl = clamp(high_low_ratio * 100.0)
    presence = clamp(perc_share / 0.11, 0.0, 1.0) ** 0.80
    if perc_onset_rate < 2.2 and perc_share < 0.07:
        presence *= clamp(perc_onset_rate / 2.2, 0.0, 1.0)
    base_dc = 0.32 * s_perc + presence * (0.28 * s_rate + 0.24 * s_sync + 0.16 * s_hl)
    brk_lift = presence * (0.14 * max(0.0, breakbeat_score - 35.0))
    return round(clamp(base_dc + brk_lift), 1)


def compute_groove_metrics(P: np.ndarray, P_p: np.ndarray, freqs: np.ndarray, fps: float, bpm_est: float, perc_share: float, gap_ent: float) -> dict:
    """Fold bar-aligned 16-step kick/snare/hat profiles to separate 4/4 pulses from breakbeats."""
    if perc_share < 0.055 or P.shape[1] < 32:
        return {
            "four_on_floor": 0.0,
            "breakbeat_score": 0.0,
            "chop_var": 0.0,
            "groove_style": "ambient",
        }

    def band_flux(lo_hz: float, hi_hz: float, use_total_mix: bool = False) -> np.ndarray:
        m = (freqs >= lo_hz) & (freqs <= hi_hz)
        src = (0.55 * P_p[m] + 0.45 * P[m]) if use_total_mix else P_p[m]
        env = np.sqrt(src.sum(axis=0) + 1e-12)
        fl = np.maximum(0.0, np.diff(np.log1p(14.0 * env), prepend=0.0))
        return fl

    fl_k = band_flux(35.0, 155.0, use_total_mix=True)
    fl_sn = band_flux(170.0, 2400.0, use_total_mix=False)
    fl_hh = band_flux(2400.0, 9000.0, use_total_mix=False)

    # Focus on the most percussive ~45s contiguous section to avoid quiet intro dilution & drift
    seg_len = min(len(fl_k), max(64, int(round(45.0 * fps))))
    tot_p = np.sqrt(P_p[(freqs >= 140.0) & (freqs <= 9000.0)].sum(axis=0) + 1e-12)
    if len(tot_p) > seg_len:
        cs = np.cumsum(np.insert(tot_p, 0, 0.0))
        best_s = int(np.argmax(cs[seg_len:] - cs[:-seg_len]))
    else:
        best_s = 0
    best_e = best_s + seg_len

    bar_sec = 240.0 / max(55.0, min(200.0, float(bpm_est)))
    bar_frames = max(16.0, bar_sec * fps)
    block_frames = max(int(round(4.0 * bar_frames)), 32)
    n_blocks = max(1, (best_e - best_s) // block_frames)

    K_acc = np.zeros(16, dtype=np.float64)
    SN_acc = np.zeros(16, dtype=np.float64)
    HH_acc = np.zeros(16, dtype=np.float64)
    block_sigs = []

    for bi in range(n_blocks):
        a = best_s + bi * block_frames
        b = min(best_e, a + block_frames)
        t_rel = (np.arange(a, b) - a) / fps
        step_idx = np.floor((t_rel / bar_sec) * 16.0).astype(int) % 16
        Kb = np.bincount(step_idx, weights=fl_k[a:b], minlength=16).astype(np.float64)
        SNb = np.bincount(step_idx, weights=fl_sn[a:b], minlength=16).astype(np.float64)
        HHb = np.bincount(step_idx, weights=fl_hh[a:b], minlength=16).astype(np.float64)
        cnts = np.maximum(1.0, np.bincount(step_idx, minlength=16).astype(np.float64))
        Kb /= cnts
        SNb /= cnts
        HHb /= cnts
        block_sigs.append(Kb / (Kb.sum() + 1e-9))

        # Circularly align each 4-bar block's phase so slight tempo drift across long tracks never smears hits
        if bi == 0:
            K_ref = Kb
            shift = 0
        else:
            scores = [float(np.dot(np.roll(Kb, -sh), K_ref)) for sh in range(16)]
            shift = int(np.argmax(scores))
        K_acc += np.roll(Kb, -shift)
        SN_acc += np.roll(SNb, -shift)
        HH_acc += np.roll(HHb, -shift)

    # Subtract flat noise floor so sharp step transients stand out cleanly
    def sharpen(v: np.ndarray) -> np.ndarray:
        v0 = np.maximum(0.0, v - float(np.percentile(v, 20)))
        return v0 / (v0.sum() + 1e-9)

    Kp = sharpen(K_acc)
    SNp = sharpen(SN_acc)
    HHp = sharpen(HH_acc)

    # Rotate onto dominant quarter-note kick phase (0..3 -> beats 0, 4, 8, 12)
    best_q_phase = int(np.argmax([float(Kp[[p, p + 4, p + 8, p + 12]].sum()) for p in range(4)]))
    Kr = np.roll(Kp, -best_q_phase)
    SNr = np.roll(SNp, -best_q_phase)

    q_vals = np.sort(Kr[[0, 4, 8, 12]])
    q_total_share = float(q_vals.sum())
    q_min2_ratio = float((q_vals[0] + q_vals[1]) / (q_vals[2] + q_vals[3] + 1e-9))
    sync_kicks = float(Kr[[2, 3, 6, 7, 10, 11, 14, 15]].sum())

    # Backbeat snare without co-occurring heavy kick vs ghost snare complexity
    sn_active = int(np.sum(SNr > (0.35 * float(np.max(SNr)) + 1e-9)))
    ghost_richness = clamp((sn_active - 2) / 6.0, 0.0, 1.0)
    hat_16_density = clamp(float(np.sum(HHp > 0.25 * float(np.max(HHp)) + 1e-9)) / 12.0, 0.0, 1.0)

    if len(block_sigs) >= 2:
        diffs = [1.0 - float(np.dot(block_sigs[i], block_sigs[i + 1]) / (np.linalg.norm(block_sigs[i]) * np.linalg.norm(block_sigs[i + 1]) + 1e-9)) for i in range(len(block_sigs) - 1)]
        chop_var = float(np.mean(diffs))
    else:
        chop_var = 0.15

    rhythm_gate_4x4 = clamp((perc_share - 0.04) / 0.22, 0.0, 1.0)
    rhythm_gate_brk = clamp((perc_share - 0.04) / 0.14, 0.0, 1.0)
    raw_4x4 = (
        50.0 * clamp((q_total_share - 0.24) / 0.34, 0.0, 1.0)
        + 50.0 * clamp((q_min2_ratio - 0.22) / 0.58, 0.0, 1.0)
    ) * (1.0 - 0.45 * clamp((sync_kicks - 0.44) / 0.26, 0.0, 1.0))

    raw_brk = (
        34.0 * clamp((0.68 - q_min2_ratio) / 0.56, 0.0, 1.0)
        + 28.0 * clamp((sync_kicks - 0.34) / 0.28, 0.0, 1.0)
        + 18.0 * clamp(gap_ent, 0.0, 1.0)
        + 12.0 * ghost_richness
        + 8.0 * clamp(chop_var / 0.35, 0.0, 1.0)
    ) * (0.65 + 0.35 * hat_16_density)

    four_on_floor = round(clamp(rhythm_gate_4x4 * raw_4x4), 1)
    breakbeat_score = round(clamp(rhythm_gate_brk * raw_brk), 1)

    if four_on_floor >= breakbeat_score + 6.0 and four_on_floor >= 36.0:
        g_style = "four_on_floor"
    elif breakbeat_score >= four_on_floor + 4.0 and breakbeat_score >= 34.0:
        g_style = "breakbeat"
    elif perc_share >= 0.09:
        g_style = "downtempo"
    else:
        g_style = "ambient"

    return {
        "four_on_floor": four_on_floor,
        "breakbeat_score": breakbeat_score,
        "chop_var": round(chop_var, 3),
        "groove_style": g_style,
    }


def analyze_harmony_and_rhythm(y: np.ndarray, bpm_est: float) -> dict:
    """Compute HPSS chromagram macro harmonic complexity, modal darkness, microtonal index, and groove/drum complexity."""
    sr = float(dsp_models.SR)
    nfft = 2048
    hop = 512
    nfr = 1 + max(0, (len(y) - nfft) // hop)
    if nfr < 24:
        return {
            "key_camelot": "5A", "key_label": "Cm", "tonic_pc": 0, "is_minor": True,
            "chord_richness": 45.0, "harmonic_motion": 40.0, "modal_darkness": 50.0,
            "microtonal_score": 15.0, "harmonic_complexity": 45.0,
            "drum_complexity": 35.0, "perc_share": 0.25, "perc_onset_rate": 2.0,
            "gap_cv": 0.2, "gap_entropy": 0.1, "high_low_ratio": 0.3,
            "four_on_floor": 20.0, "breakbeat_score": 20.0, "groove_style": "downtempo",
            "scale_deg_12": [round(1 / 12, 4)] * 12,
        }

    win = np.hanning(nfft).astype(np.float32)
    frames = []
    for s0 in range(0, nfr, 512):
        e0 = min(nfr, s0 + 512)
        idx = np.arange(nfft)[None, :] + hop * np.arange(s0, e0)[:, None]
        frames.append(np.abs(np.fft.rfft(y[idx] * win, axis=1)).astype(np.float32))
    S = np.vstack(frames).T  # (n_bins, n_frames)

    # Harmonic-Percussive separation
    S_h = median_filter(S, size=(1, 17))
    S_p = median_filter(S, size=(17, 1))
    denom = S_h ** 2 + S_p ** 2 + 1e-12
    P_h = (S * (S_h ** 2 / denom)) ** 2
    P_p = (S * (S_p ** 2 / denom)) ** 2
    P_tot = P_h + P_p + 1e-12

    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)

    # Band-weighted percussive share so heavy jungle/dub sub-bass does not mask sharp upper drums
    m_hi = (freqs >= 160.0) & (freqs <= 9000.0)
    m_lo = (freqs >= 45.0) & (freqs < 160.0)
    perc_hi = float(P_p[m_hi].sum() / (P_tot[m_hi].sum() + 1e-12))
    perc_lo = float(P_p[m_lo].sum() / (P_tot[m_lo].sum() + 1e-12))
    perc_share = 0.82 * perc_hi + 0.18 * perc_lo

    # Map midrange-filtered harmonic bins (95 Hz .. 3000 Hz) onto 12 pitch classes
    # so heavy sub-bass fundamentals never drown out upper triad/extension voicings.
    mask_pitch = (freqs >= 95.0) & (freqs <= 3000.0)
    f_p = freqs[mask_pitch]
    midi_f = 69.0 + 12.0 * np.log2(f_p / 440.0)
    pc_bin = np.round(midi_f).astype(int) % 12
    dev_st = np.abs(midi_f - np.round(midi_f))

    P_sub = P_h[mask_pitch, :]
    chroma = np.zeros((12, P_h.shape[1]), dtype=np.float64)
    for pc in range(12):
        m_pc = pc_bin == pc
        if np.any(m_pc):
            chroma[pc] = P_sub[m_pc].sum(axis=0)

    # Microtonal / off-12-TET shimmer score from harmonic energy off the exact semitone centers
    peak_dev = np.average(dev_st[:, None] * np.ones((1, P_sub.shape[1])), weights=P_sub + 1e-12)
    microtonal_score = clamp((float(peak_dev) - 0.14) / 0.18 * 100.0)

    # Global key via Krumhansl-Schmuckler
    mean_c = chroma.mean(axis=1)
    if mean_c.sum() > 0:
        mean_c_z = (mean_c - mean_c.mean()) / (mean_c.std() + 1e-9)
    else:
        mean_c_z = np.ones(12) / 12.0

    best_corr = -999.0
    tonic_pc = 0
    is_minor = True
    for k in range(12):
        maj_rot = np.roll(KS_MAJOR, k)
        min_rot = np.roll(KS_MINOR, k)
        c_maj = float(np.dot(mean_c_z, (maj_rot - maj_rot.mean()) / maj_rot.std()))
        c_min = float(np.dot(mean_c_z, (min_rot - min_rot.mean()) / min_rot.std()))
        if c_maj > best_corr:
            best_corr, tonic_pc, is_minor = c_maj, k, False
        if c_min > best_corr:
            best_corr, tonic_pc, is_minor = c_min, k, True

    key_camelot = CAMELOT_MINOR[tonic_pc] if is_minor else CAMELOT_MAJOR[tonic_pc]
    key_name = NOTE_PC_MINOR[tonic_pc] if is_minor else NOTE_PC_MAJOR[tonic_pc]
    key_label = f"{key_name} ({key_camelot})"

    # Tonic-rotated 12-degree pitch class histogram
    rot_mean = np.roll(mean_c, -tonic_pc)
    rot_norm = rot_mean / (rot_mean.sum() + 1e-12)

    # Modal darkness: dark/tense degrees (b2[1], b3[3], b5[6], b6[8], b7[10]) vs bright degrees (2[2], 3[4], 6[9], 7[11])
    dark_mass = float(1.4 * rot_norm[1] + 1.2 * rot_norm[3] + 1.2 * rot_norm[6] + 1.1 * rot_norm[8] + 0.7 * rot_norm[10])
    bright_mass = float(0.8 * rot_norm[2] + 1.3 * rot_norm[4] + 1.0 * rot_norm[9] + 1.0 * rot_norm[11])
    raw_dark = dark_mass / (dark_mass + bright_mass + 1e-9)
    modal_darkness = clamp((raw_dark - 0.18) / 0.62 * 100.0)
    if is_minor:
        modal_darkness = clamp(0.75 * modal_darkness + 22.0)

    # 2-bar / ~4-second windows for chord richness & harmonic motion
    fps = sr / hop
    win_frames = max(8, int(round((240.0 / max(60.0, min(180.0, bpm_est))) * fps)))
    n_win = chroma.shape[1] // win_frames
    if n_win < 2:
        win_frames = max(4, chroma.shape[1] // 4)
        n_win = chroma.shape[1] // max(1, win_frames)

    win_vecs = []
    frame_e = chroma.sum(axis=0)
    e_thresh = float(np.percentile(frame_e, 20)) * 0.5
    for w in range(n_win):
        seg = chroma[:, w * win_frames : (w + 1) * win_frames]
        if seg.sum() <= e_thresh * win_frames:
            continue
        v = seg.sum(axis=1)
        vn = v / (v.sum() + 1e-12)
        win_vecs.append(vn)

    if win_vecs:
        W = np.array(win_vecs)  # (K, 12)
        # Effective pitch classes per window: exp(entropy) in [1, 12]
        eff_pcs = []
        for vn in W:
            nz = vn[vn > 1e-4]
            H = -float(np.sum(nz * np.log(nz)))
            eff_pcs.append(math.exp(H))
        med_eff = float(np.median(eff_pcs))
        chord_richness = clamp((med_eff - 3.2) / 6.2 * 100.0)

        # Inter-window chord/progression motion
        if len(W) >= 2:
            cos_sims = []
            root_changes = 0
            for i in range(len(W) - 1):
                a, b = W[i], W[i + 1]
                sim = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
                cos_sims.append(1.0 - sim)
                if int(np.argmax(a)) != int(np.argmax(b)):
                    root_changes += 1
            mean_diff = float(np.mean(cos_sims))
            root_rate = root_changes / max(1, len(W) - 1)
            harmonic_motion = clamp(0.65 * (mean_diff / 0.28 * 100.0) + 0.35 * (root_rate * 100.0))
        else:
            harmonic_motion = 20.0
    else:
        chord_richness = 35.0
        harmonic_motion = 25.0

    harmonic_complexity = clamp(0.42 * chord_richness + 0.35 * harmonic_motion + 0.23 * modal_darkness)

    # Drum & rhythm complexity from P_p
    p_env_low = P_p[(freqs >= 25.0) & (freqs < 200.0), :].sum(axis=0)
    p_env_high = P_p[(freqs >= 250.0) & (freqs < 8000.0), :].sum(axis=0)
    p_tot_env = np.sqrt(P_p.sum(axis=0) + 1e-12)
    flux_p = np.maximum(0.0, np.diff(np.log1p(12.0 * p_tot_env), prepend=0.0))
    thr_p = float(flux_p.mean() + 0.6 * flux_p.std())
    onsets_idx = np.flatnonzero((flux_p[1:-1] > flux_p[:-2]) & (flux_p[1:-1] >= flux_p[2:]) & (flux_p[1:-1] > thr_p)) + 1
    dur_s = len(y) / sr
    perc_onset_rate = len(onsets_idx) / max(1.0, dur_s)

    if len(onsets_idx) >= 4:
        gaps = np.diff(onsets_idx) / fps
        gap_cv = float(np.std(gaps) / (np.mean(gaps) + 1e-9))
        # Shannon entropy of quantized inter-onset gaps (breakbeats/polyrhythms have high gap variety)
        q_gaps = np.round(np.clip(gaps * (bpm_est / 60.0) * 4.0, 1, 16)).astype(int)
        vals, cnts = np.unique(q_gaps, return_counts=True)
        pr = cnts / cnts.sum()
        gap_ent = float(-(pr * np.log(pr)).sum() / math.log(8.0))
    else:
        gap_cv = 0.2
        gap_ent = 0.1

    # High-to-low percussive complexity ratio & 16-step groove archetype (4/4 vs breakbeat)
    high_low_ratio = float(p_env_high.mean() / (p_env_low.mean() + p_env_high.mean() + 1e-9))
    groove = compute_groove_metrics(S ** 2, P_p, freqs, fps, bpm_est, perc_share, gap_ent)
    drum_complexity = compute_drum_complexity(
        perc_share, perc_onset_rate, gap_cv, gap_ent, high_low_ratio, groove["breakbeat_score"]
    )

    return {
        "key_camelot": key_camelot,
        "key_label": key_label,
        "tonic_pc": int(tonic_pc),
        "is_minor": bool(is_minor),
        "chord_richness": round(chord_richness, 1),
        "harmonic_motion": round(harmonic_motion, 1),
        "modal_darkness": round(modal_darkness, 1),
        "microtonal_score": round(microtonal_score, 1),
        "harmonic_complexity": round(harmonic_complexity, 1),
        "drum_complexity": drum_complexity,
        "perc_share": round(perc_share, 3),
        "perc_onset_rate": round(perc_onset_rate, 2),
        "gap_cv": round(gap_cv, 3),
        "gap_entropy": round(gap_ent, 3),
        "high_low_ratio": round(high_low_ratio, 3),
        "four_on_floor": groove["four_on_floor"],
        "breakbeat_score": groove["breakbeat_score"],
        "groove_style": groove["groove_style"],
        "scale_deg_12": [round(float(x), 4) for x in rot_norm],
    }


def make_tags(t: dict) -> tuple[str, str]:
    hc = t["harmonic_complexity"]
    cr = t["chord_richness"]
    hm = t["harmonic_motion"]
    md = t["modal_darkness"]
    ms = t["microtonal_score"]
    if ms >= 48 and t["era"] in ("le_garage", "ep_concepts", "sketches_2024_25", "remixes_commissions"):
        h_tag = "Microtonal / bell intervals"
    elif cr >= 62 and hm >= 55:
        h_tag = "Lush moving chords"
    elif cr >= 62:
        h_tag = "Rich extended voicings"
    elif hm >= 58:
        h_tag = "Active chord progressions"
    elif md >= 62 and hm < 42:
        h_tag = "Dark modal pedal"
    elif md >= 58:
        h_tag = "Minor / Phrygian tension"
    elif cr < 38 and hm < 40:
        h_tag = "Open 5th / drone"
    else:
        h_tag = "Balanced modal harmony"

    dc = t["drum_complexity"]
    en = t["energy"]
    bpm = t["bpm"]
    pc = t["perc_share"]
    f4 = float(t.get("four_on_floor", 0.0))
    brk = float(t.get("breakbeat_score", 0.0))
    if dc < 24 and pc < 0.08:
        r_tag = "Beatless ambient wash"
    elif dc < 36:
        r_tag = "Spacious / minimal pulse"
    elif bpm >= 158 and dc >= 48 and brk >= 35:
        r_tag = "Fast D&B / jungle breaks"
    elif brk >= f4 + 6.0 and brk >= 36.0:
        r_tag = "Breakbeat / syncopated groove"
    elif f4 >= 45.0 and en >= 5:
        r_tag = "Driven 4/4 house pulse"
    elif f4 >= 36.0:
        r_tag = "Steady 4/4 pulse"
    elif en <= 5 and bpm < 95:
        r_tag = "Chill downtempo groove"
    else:
        r_tag = "Steady electronic beat"

    return h_tag, r_tag


def effective_tempo(t: dict) -> float:
    """Anchor beatless ambient tracks near 68 BPM so nominal DAW project BPMs never split ambient washes."""
    dc = float(t.get("drum_complexity", 0.0))
    r_conf = clamp((dc - 16.0) / 14.0, 0.0, 1.0)
    return round(r_conf * float(t["bpm"]) + (1.0 - r_conf) * 68.0, 2)


def gate_rhythm_features(t: dict) -> None:
    """Recompute canonical drum complexity, effective BPM, and 4/4 vs breakbeat pulse for clustering."""
    if all(k in t for k in ("perc_share", "perc_onset_rate", "gap_cv", "gap_entropy", "high_low_ratio")):
        t["drum_complexity"] = compute_drum_complexity(
            float(t["perc_share"]),
            float(t["perc_onset_rate"]),
            float(t["gap_cv"]),
            float(t["gap_entropy"]),
            float(t["high_low_ratio"]),
            float(t.get("breakbeat_score", 0.0)),
        )
    t["effective_bpm"] = effective_tempo(t)
    pc = float(t.get("perc_share", 0.0))
    pul_presence = clamp((pc - 0.02) / 0.10, 0.0, 1.0)
    t["drum_pulse"] = round(float(t.get("pulse_clarity", 0.0)) * pul_presence * 100.0, 1)


def cluster_and_layout(tracks: list[dict]) -> dict:
    """Cluster tracks into cohesive musical style groups and project both Similarity & Era 2D maps."""
    for t in tracks:
        gate_rhythm_features(t)

    # 9-feature similarity space: Groove (Breakbeat vs 4/4), Effective Tempo, Energy, Drums, and Macro Harmony
    weights = np.array([
        2.05,  # MIK Energy (1-10)
        2.75,  # Effective BPM (strongly separates 75 BPM downtempo from 112-120 BPM mid-tempo & 170 BPM D&B)
        1.85,  # Drum Complexity (sub-bass-compensated)
        2.85,  # Breakbeat / Syncopated Breaks Score (groups all true breakbeats regardless of chord richness)
        2.30,  # 4/4 Four-on-the-Floor Regularity (groups steady 4/4 club pulses cleanly away from breakbeats)
        1.05,  # Macro Harmonic Complexity
        0.45,  # Chord Richness
        0.35,  # Harmonic Motion
        0.25,  # Modal Darkness
    ])
    X_raw = np.array([
        [
            t["energy"],
            t["effective_bpm"],
            t["drum_complexity"],
            t.get("breakbeat_score", 0.0),
            t.get("four_on_floor", 0.0),
            t["harmonic_complexity"],
            t["chord_richness"],
            t["harmonic_motion"],
            t["modal_darkness"],
        ]
        for t in tracks
    ], dtype=np.float64)
    X_std = StandardScaler().fit_transform(X_raw) * weights
    D = np.linalg.norm(X_std[:, None, :] - X_std[None, :, :], axis=2)

    best_k = 6
    best_labels = AgglomerativeClustering(n_clusters=best_k, linkage="ward").fit_predict(X_std)
    best_sc = float(silhouette_score(X_std, best_labels))

    # Build raw cluster stats
    clusters_raw = []
    for cid in range(best_k):
        idxs = [i for i, l in enumerate(best_labels) if l == cid]
        clusters_raw.append({
            "orig_id": cid,
            "idxs": idxs,
            "en": float(np.mean([tracks[i]["energy"] for i in idxs])),
            "bpm": float(np.mean([tracks[i]["effective_bpm"] for i in idxs])),
            "dc": float(np.mean([tracks[i]["drum_complexity"] for i in idxs])),
            "brk": float(np.mean([tracks[i].get("breakbeat_score", 0.0) for i in idxs])),
            "f4": float(np.mean([tracks[i].get("four_on_floor", 0.0) for i in idxs])),
            "dp": float(np.mean([tracks[i]["drum_pulse"] for i in idxs])),
            "perc": float(np.mean([tracks[i]["perc_share"] for i in idxs])),
            "hc": float(np.mean([tracks[i]["harmonic_complexity"] for i in idxs])),
            "cr": float(np.mean([tracks[i]["chord_richness"] for i in idxs])),
            "micro": float(np.mean([tracks[i]["microtonal_score"] for i in idxs])),
        })

    # Order clusters smoothly from quiet Ambient -> Downtempo Lush -> Chill -> Hypnotic 4/4 -> Ecstatic House -> Complex Breaks
    clusters_raw.sort(key=lambda c: (c["dc"] >= 22, c["en"], c["dc"], c["brk"]))
    T_PALETTE_HUES = [205, 165, 275, 35, 130, 340]

    archetypes = [
        ("ambient", "Ambient & meditative", lambda c: (140.0 if c["dc"] < 22 else 0.0) + (10 - c["en"]) * 3.0 - c["dc"] * 0.5),
        ("downtempo_lush", "Downtempo & lush chords", lambda c: (110.0 if c["dc"] >= 22 and c["f4"] < 30.0 and c["brk"] < 30.0 else 0.0) + c["cr"] * 0.5 - c["en"] * 5.0 - c["brk"] * 0.4),
        ("chill_elec", "Chill & steady electronic", lambda c: (125.0 if c["dc"] >= 22 and c["bpm"] < 105.0 and c["brk"] < 35.0 else 0.0) + (110.0 - c["bpm"]) * 0.8 - c["brk"] * 0.4),
        ("hypnotic_micro", "Hypnotic electro & microtonal", lambda c: (95.0 if 95.0 <= c["bpm"] < 132.0 and c["dc"] >= 50.0 else 0.0) + c["dc"] * 0.7 + c["micro"] * 0.6 + c["brk"] * 0.3),
        ("house_ecstatic", "House & ecstatic 4/4 groove", lambda c: c["f4"] * 1.4 + (75.0 if c["bpm"] >= 120.0 and c["f4"] >= 65.0 else 0.0) + c["en"] * 4.0 - c["brk"] * 0.6),
        ("dnb_breaks", "Complex drums & breaks", lambda c: c["brk"] * 2.2 + c["dc"] * 1.1 + c["bpm"] * 0.35 - c["f4"] * 0.8),
    ]
    orig_to_name = {}
    pairs2 = []
    for c in clusters_raw:
        for aid, alabel, fn in archetypes:
            pairs2.append((fn(c), c["orig_id"], aid, alabel))
    pairs2.sort(reverse=True)
    used_a2 = set()
    for sc, oid, aid, alabel in pairs2:
        if oid in orig_to_name or aid in used_a2:
            continue
        orig_to_name[oid] = (aid, alabel)
        used_a2.add(aid)

    style_groups = []
    for t in tracks:
        t.pop("_dc_gated", None)

    # 2D t-SNE projection
    perp = min(14, max(5, len(tracks) // 5))
    tsne = TSNE(n_components=2, perplexity=perp, init="pca", learning_rate="auto", random_state=42)
    xy = tsne.fit_transform(X_std)
    xy = (xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0) + 1e-9)

    # Gentle centroid blend (22%) + minimum distance repulsion so dots breathe clearly
    cid_to_members = {c["orig_id"]: c["idxs"] for c in clusters_raw}
    for oid, idxs in cid_to_members.items():
        cent = xy[idxs].mean(axis=0)
        xy[idxs] = 0.78 * xy[idxs] + 0.22 * cent

    # Simple repulsion pass in normalized [0.08, 0.92]
    for _ in range(45):
        for i in range(len(xy)):
            for j in range(i + 1, len(xy)):
                dx, dy = xy[i, 0] - xy[j, 0], xy[i, 1] - xy[j, 1]
                d = math.hypot(dx, dy)
                if 0 < d < 0.038:
                    push = (0.038 - d) * 0.36
                    ux, uy = dx / d, dy / d
                    xy[i, 0] += ux * push
                    xy[i, 1] += uy * push
                    xy[j, 0] -= ux * push
                    xy[j, 1] -= uy * push
    xy = 0.07 + 0.86 * ((xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0) + 1e-9))

    for gi, c in enumerate(clusters_raw):
        aid, alabel = orig_to_name[c["orig_id"]]
        gid = f"s{gi}_{aid}"
        cent = xy[c["idxs"]].mean(axis=0)
        min_x = float(np.min(xy[c["idxs"], 0]))
        max_x = float(np.max(xy[c["idxs"], 0]))
        min_y = float(np.min(xy[c["idxs"], 1]))
        max_y = float(np.max(xy[c["idxs"], 1]))
        member_ids = [tracks[i]["id"] for i in c["idxs"]]
        for i in c["idxs"]:
            tracks[i]["cluster_id"] = gid
            tracks[i]["cluster_label"] = alabel
            tracks[i]["cluster_idx"] = gi
            h_tag, r_tag = make_tags(tracks[i])
            tracks[i]["harmony_tag"] = h_tag
            tracks[i]["rhythm_tag"] = r_tag

        pref_x, pref_y = float(cent[0]), max(0.055, min_y - 0.048)
        candidates = [
            (pref_x, pref_y),
            (float(cent[0]), min(0.94, max_y + 0.052)),
            (max(0.13, min_x - 0.02), max(0.055, min_y - 0.046)),
            (min(0.87, max_x + 0.02), max(0.055, min_y - 0.046)),
            (max(0.13, min_x - 0.02), min(0.94, max_y + 0.050)),
            (min(0.87, max_x + 0.02), min(0.94, max_y + 0.050)),
        ]

        def _label_penalty(cand: tuple[float, float]) -> float:
            cx_c = min(0.87, max(0.13, cand[0]))
            cy_c = min(0.94, max(0.055, cand[1]))
            dot_pen = sum(
                20.0 * (1.0 - max(abs(float(xy[k, 0]) - cx_c) / 0.11, abs(float(xy[k, 1]) - cy_c) / 0.038))
                for k in range(len(xy))
                if abs(float(xy[k, 0]) - cx_c) < 0.11 and abs(float(xy[k, 1]) - cy_c) < 0.038
            )
            grp_pen = sum(
                60.0 * (1.0 - max(abs(g["cx"] - cx_c) / 0.22, abs(g["cy"] - cy_c) / 0.075))
                for g in style_groups
                if abs(g["cx"] - cx_c) < 0.22 and abs(g["cy"] - cy_c) < 0.075
            )
            return dot_pen + grp_pen + 0.15 * math.hypot(cx_c - pref_x, cy_c - pref_y)

        best_cand = min(candidates, key=_label_penalty)
        lx = min(0.87, max(0.13, best_cand[0]))
        ly = min(0.94, max(0.055, best_cand[1]))
        style_groups.append({
            "id": gid,
            "label": alabel,
            "idx": gi,
            "hue": T_PALETTE_HUES[gi % len(T_PALETTE_HUES)],
            "members": member_ids,
            "cx": round(float(lx), 4),
            "cy": round(float(ly), 4),
        })

    # Nearest neighbors
    scale = float(np.median(D[D > 0])) or 1.0
    track_near = {}
    for i, t in enumerate(tracks):
        order = [j for j in np.argsort(D[i]) if j != i][:4]
        track_near[t["id"]] = [[tracks[j]["id"], round(float(math.exp(-D[i, j] / scale)), 3)] for j in order]

    # Era View 4x4 chronological layout (16 eras -> 4 cols x 4 rows)
    track_map = {}
    era_anchors = []
    era_to_indices = {eid: [] for eid in ERA_ORDER}
    for i, t in enumerate(tracks):
        era_to_indices.setdefault(t["era"], []).append(i)

    for e_idx, eid in enumerate(ERA_ORDER):
        row = e_idx // 4
        col = e_idx % 4
        cx = 0.13 + col * 0.245
        cy = 0.145 + row * 0.242
        members = era_to_indices.get(eid, [])
        # Sort members by energy so highest-energy sits cleanly in constellation order
        members_sorted = sorted(members, key=lambda idx: (tracks[idx]["energy"], tracks[idx]["slot"]))
        n_m = len(members_sorted)
        r_ring = 0.042 if n_m >= 5 else (0.036 if n_m >= 3 else 0.025)
        for k, ti in enumerate(members_sorted):
            ang = -math.pi / 2 + (2 * math.pi * k) / max(1, n_m)
            ex = cx + r_ring * math.cos(ang)
            ey = cy + r_ring * 0.85 * math.sin(ang) + 0.008
            tid = tracks[ti]["id"]
            track_map[tid] = {
                "similarity": [round(float(xy[ti, 0]), 4), round(float(xy[ti, 1]), 4)],
                "era": [round(ex, 4), round(ey, 4)],
            }
        era_anchors.append({
            "id": eid,
            "idx": e_idx,
            "x": round(cx, 4),
            "y": round(cy - 0.072, 4),
            "cx": round(cx, 4),
            "cy": round(cy, 4),
        })

    return {
        "silhouette": round(float(best_sc), 3),
        "style_groups": style_groups,
        "track_map": track_map,
        "era_anchors": era_anchors,
        "track_near": track_near,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus-root", default="")
    ap.add_argument("--archive-root", default="")
    ap.add_argument("--skip-mik-gui", action="store_true")
    ap.add_argument("--recluster-only", action="store_true", help="Recompute gated rhythm & similarity clustering from existing scripts/track_analysis.json")
    args = ap.parse_args()

    if args.recluster_only:
        in_path = SCRIPTS_DIR / "track_analysis.json"
        existing = json.loads(in_path.read_text(encoding="utf-8"))
        analyzed_tracks = existing["tracks"]
        for t in analyzed_tracks:
            # Mark un-gated tracks if coming from initial pre-gate run
            if t["id"] == "hd_2005_3" and t["bpm"] > 200:
                t["bpm"] = 170.0
        layout = cluster_and_layout(analyzed_tracks)
        out = {
            "n_tracks": len(analyzed_tracks),
            "silhouette": layout["silhouette"],
            "style_groups": layout["style_groups"],
            "track_map": layout["track_map"],
            "era_anchors": layout["era_anchors"],
            "track_near": layout["track_near"],
            "tracks": analyzed_tracks,
        }
        in_path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Reclustered {len(analyzed_tracks)} tracks -> silhouette={layout['silhouette']}")
        for g in layout["style_groups"]:
            names = [next(t["title"] for t in analyzed_tracks if t["id"] == m) for m in g["members"]]
            print(f"  [{g['id']}] {g['label']} ({len(names)}): {', '.join(names[:8])}{' ...' if len(names) > 8 else ''}")
        return

    if not args.corpus_root or not args.archive_root:
        ap.error("--corpus-root and --archive-root are required unless --recluster-only is set")

    corpus_root = Path(args.corpus_root).expanduser()
    archive_root = Path(args.archive_root).expanduser()
    ffmpeg_bin = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"

    mik_db = lookup_mik_db()
    print(f"Loaded {len(mik_db)} rows from Mixed In Key Collection10.mikdb")

    # Stage 90s MP3 excerpts for untagged tracks so MIK never touches source originals
    stage_dir = Path("/tmp/music_evo_mik_stage")
    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    stage_dir.mkdir(parents=True, exist_ok=True)

    resolved_sources = {}
    for spec in pa.TRACK_SPECS:
        src_kind, era, slot, title, default_bpm, rel, *rest = spec
        fixed_cue = float(rest[0]) if rest else None
        tid = f"{era}_{slot}"
        src = pa.resolve_corpus_path(archive_root if src_kind == "archive" else corpus_root, rel)
        resolved_sources[tid] = (src_kind, era, slot, title, default_bpm, src, fixed_cue)

        # Stage only if not in MIK DB or source tags (and accessibility might be enabled)
        k_norm = "".join(c for c in src.stem.lower() if c.isalnum())
        src_tags = read_mutagen_mik(src)
        if not src_tags.get("energy") and k_norm not in mik_db and not args.skip_mik_gui:
            st_mp3 = stage_dir / f"{tid}.mp3"
            ss = max(0.0, (fixed_cue or 20.0) - 5.0)
            subprocess.run(
                [ffmpeg_bin, "-y", "-v", "error", "-ss", f"{ss:.1f}", "-t", "90", "-i", str(src), "-vn", "-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "160k", str(st_mp3)],
                capture_output=True, check=False
            )

    staged_files = list(stage_dir.glob("*.mp3"))
    mik_gui_tags = {}
    if staged_files and not args.skip_mik_gui and MIK_SCRIPT.exists() and can_run_mik_gui():
        print(f"Accessibility active! Running mik_analyze.py on {len(staged_files)} staged clips...")
        subprocess.run([sys.executable, str(MIK_SCRIPT), str(stage_dir)], check=False, timeout=360)
        for st in staged_files:
            mt = read_mutagen_mik(st)
            if mt:
                mik_gui_tags[st.stem] = mt
    else:
        print(f"MIK GUI skipped/unavailable ({len(staged_files)} untagged); using MIK DB + source tags + DJVibes calibrated MIK model.")

    bpm_overrides = {}
    manifest_bpm_by_id = {}
    manifest_path = SCRIPTS_DIR / "audio_manifest.json"
    if manifest_path.exists():
        m_json = json.loads(manifest_path.read_text(encoding="utf-8"))
        for lst in m_json.get("tracks_by_era", {}).values():
            for mt in lst:
                manifest_bpm_by_id[mt["id"]] = float(mt["bpm"])

    analyzed_tracks = []

    try:
        for tid, (src_kind, era, slot, title, default_bpm, src, fixed_cue) in resolved_sources.items():
            # Prefer canonical BPM stored in audio_manifest.json so loop playback & beat LEDs stay sample-exact.
            src_tags = read_mutagen_mik(src)
            k_norm = "".join(c for c in src.stem.lower() if c.isalnum())
            db_hit = mik_db.get(k_norm, {})
            gui_hit = mik_gui_tags.get(tid, {})

            mik_en = gui_hit.get("energy") or src_tags.get("energy") or db_hit.get("energy")
            mik_bpm = gui_hit.get("bpm") or src_tags.get("bpm") or db_hit.get("tempo")
            mik_key = gui_hit.get("key") or src_tags.get("key") or db_hit.get("key")

            start_s = max(0.0, fixed_cue - 20.0) if fixed_cue else 0.0
            y = decode_audio(ffmpeg_bin, src, start_s=start_s, dur_s=240.0)
            feats, env = dsp_models.analyze_signal(y)
            p = dsp_models.params()
            en_dsp = dsp_models.predict_energy(feats)
            energy = int(round(float(mik_en))) if mik_en is not None else int(en_dsp)
            energy_source = "mik" if mik_en is not None else "mik_model"

            if tid in manifest_bpm_by_id:
                bpm = float(manifest_bpm_by_id[tid])
            else:
                theta = p["bpm"]["theta"]
                xs, C = dsp_models._prepare(env)
                bpm_hint = float(mik_bpm) if mik_bpm else None
                if bpm_hint:
                    bpm0 = bpm_hint
                else:
                    bpm_raw, ratio = dsp_models.coarse_bpm(theta, C)
                    is_dnb = tid in DNB_HINTS or any(h in title.lower() for h in DNB_HINTS)
                    if is_dnb and bpm_raw < 120:
                        bpm0 = bpm_raw * 2.0
                    elif is_dnb:
                        bpm0 = bpm_raw
                    else:
                        bpm0, _ = dsp_models.half_rule(theta, bpm_raw, ratio, energy)
                bpm_fine, _, _ = dsp_models.fine_fit(xs, theta, bpm0, search=(bpm_hint is None))
                bpm = round(float(bpm_fine), 2)
                bpm_overrides[tid] = bpm

            hr = analyze_harmony_and_rhythm(y, bpm)
            key_cam = str(mik_key) if mik_key else hr["key_camelot"]
            key_label = hr["key_label"] if not mik_key else f"{hr['key_label'].split(' (')[0]} ({key_cam})"

            t_obj = {
                "id": tid,
                "era": era,
                "slot": slot,
                "source": src_kind,
                "title": title,
                "shortTitle": title.split(" (")[0][:24],
                "bpm": round(bpm, 2),
                "effective_bpm": round(bpm, 2),
                "energy": energy,
                "energy_source": energy_source,
                "key_camelot": key_cam,
                "key_label": key_label,
                "harmonic_complexity": hr["harmonic_complexity"],
                "chord_richness": hr["chord_richness"],
                "harmonic_motion": hr["harmonic_motion"],
                "modal_darkness": hr["modal_darkness"],
                "microtonal_score": hr["microtonal_score"],
                "drum_complexity": hr["drum_complexity"],
                "perc_share": hr["perc_share"],
                "perc_onset_rate": hr["perc_onset_rate"],
                "gap_cv": hr["gap_cv"],
                "gap_entropy": hr["gap_entropy"],
                "high_low_ratio": hr["high_low_ratio"],
                "four_on_floor": hr["four_on_floor"],
                "breakbeat_score": hr["breakbeat_score"],
                "groove_style": hr["groove_style"],
                "pulse_clarity": round(float(feats.get("pulse_clarity", 0.25)), 3),
                "onset_rate": round(float(feats.get("onset_rate", 2.0)), 2),
                "sub_share": round(float(feats.get("band_sub_frac", 0.2)), 3),
                "bass_share": round(float(feats.get("band_bass_frac", 0.2)), 3),
                "mid_share": round(float(feats.get("band_mid_frac", 0.2)), 3),
                "high_share": round(float(feats.get("band_high_frac", 0.1)), 3),
                "air_share": round(float(feats.get("band_air_frac", 0.05)), 3),
                "crest": round(float(feats.get("crest_mean", 10.0)), 2),
                "scale_deg_12": hr["scale_deg_12"],
            }
            h_tag, r_tag = make_tags(t_obj)
            t_obj["harmony_tag"] = h_tag
            t_obj["rhythm_tag"] = r_tag
            analyzed_tracks.append(t_obj)
            print(
                f"[{tid:22s}] E{energy:2d} {bpm:6.2f} | Harm={hr['harmonic_complexity']:4.1f} | Drum={hr['drum_complexity']:4.1f} "
                f"| 4x4={hr['four_on_floor']:4.1f} Brk={hr['breakbeat_score']:4.1f} ({hr['groove_style']})"
            )
    finally:
        if stage_dir.exists():
            shutil.rmtree(stage_dir)

    layout = cluster_and_layout(analyzed_tracks)
    out = {
        "n_tracks": len(analyzed_tracks),
        "silhouette": layout["silhouette"],
        "style_groups": layout["style_groups"],
        "track_map": layout["track_map"],
        "era_anchors": layout["era_anchors"],
        "track_near": layout["track_near"],
        "tracks": analyzed_tracks,
    }
    (SCRIPTS_DIR / "track_analysis.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    Path("/tmp/track_bpm_overrides.json").write_text(json.dumps(bpm_overrides, indent=2), encoding="utf-8")
    print(f"\nCluster summary (silhouette={layout['silhouette']}):")
    for g in layout["style_groups"]:
        names = [next(t["title"] for t in analyzed_tracks if t["id"] == m) for m in g["members"]]
        print(f"  [{g['id']}] {g['label']} ({len(names)}): {', '.join(names[:8])}{' ...' if len(names) > 8 else ''}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""DSP Macro Harmonic, Drum, Dark Ambient & Guitar/Vocal Analysis + 8-Cluster Vibe Map.

Supports two execution modes:
  1. --reanalyze-local: Re-runs real STFT/HPSS DSP & 8-cluster Vibe layout on local
     audio/*.mp3 clips merged with existing js/data.js phases/eras/metadata.
  2. --manifest catalog_manifest.json: Runs full-corpus DSP analysis across all
     discovered tracks in parallel using ThreadPoolExecutor.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter
from sklearn.cluster import AgglomerativeClustering
from sklearn.manifold import TSNE
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))
import release_catalog as rc  # noqa: E402

SR = 22050
NOTE_PC_MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
NOTE_PC_MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm", "Am", "Bbm", "Bm"]
CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64)
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64)

ERA_ORDER = [
    "present_ambient", "present_electro", "hd_2005", "bands_archive",
    "archive_2013_18", "nihon_forever", "ep_concepts", "le_garage",
    "psychedailies", "archive_2018_23", "spirit_guides", "lucid_crystal",
    "remixes_commissions", "sketches_2024_25", "ecstatic_wave", "sketches_2026",
]
ERA_DEFAULT_YEAR = {
    "present_ambient": 2002, "present_electro": 2004, "hd_2005": 2005, "bands_archive": 2010,
    "archive_2013_18": 2015, "nihon_forever": 2018, "ep_concepts": 2019, "le_garage": 2023,
    "psychedailies": 2021, "archive_2018_23": 2021, "spirit_guides": 2025, "lucid_crystal": 2026,
    "remixes_commissions": 2023, "sketches_2024_25": 2025, "ecstatic_wave": 2025, "sketches_2026": 2026,
}
PRE_2015_OVERRIDES = {
    **{f"present_ambient_{i}": 2002 + (i > 2) for i in range(1, 5)},
    **{f"present_electro_{i}": 2003 + (i > 2) for i in range(1, 6)},
    **{f"hd_2005_{i}": 2005 for i in range(1, 5)},
    "bands_archive_5": 2009, "bands_archive_6": 2014,
}
SKETCH_RE = re.compile(r"\b(sketch|ruff|idea|test|demo|loop)\b", re.IGNORECASE)


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return float(max(lo, min(hi, v)))


def decode_audio(ffmpeg_bin: str, src: Path, start_s: float = 0.0, dur_s: float = 240.0) -> np.ndarray:
    cmd = [ffmpeg_bin, "-nostdin", "-v", "error"]
    if start_s > 0:
        cmd += ["-ss", f"{start_s:.2f}"]
    cmd += ["-t", f"{dur_s:.2f}", "-i", str(src), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    res = subprocess.run(cmd, capture_output=True, check=True)
    return np.frombuffer(res.stdout, dtype=np.float32)


def estimate_bpm_and_energy(y: np.ndarray) -> tuple[float, int, float, float]:
    """Standalone energy (1-10), BPM, pulse clarity, and onset rate from audio PCM."""
    if len(y) < SR * 2:
        return 110.0, 4, 0.25, 2.0
    hop = 512
    nfr = 1 + (len(y) - 1024) // hop
    win = np.hanning(1024).astype(np.float32)
    idx = np.arange(1024)[None, :] + hop * np.arange(nfr)[:, None]
    S = np.abs(np.fft.rfft(y[idx] * win, axis=1)).astype(np.float32)
    flux = np.maximum(0.0, np.diff(np.log1p(10.0 * S), axis=0, prepend=S[:1])).mean(axis=1)
    fps = SR / hop
    # Autocorrelation tempo search (60..185 BPM)
    ac = np.correlate(flux - flux.mean(), flux - flux.mean(), mode="full")[len(flux) - 1 :]
    ac = ac / (ac[0] + 1e-9)
    lags = np.arange(int(fps * 60.0 / 185.0), min(len(ac), int(fps * 60.0 / 60.0) + 1))
    if len(lags) == 0:
        bpm, p_clar = 110.0, 0.25
    else:
        best_lag = int(lags[int(np.argmax(ac[lags]))])
        bpm = round(60.0 * fps / max(1, best_lag), 2)
        p_clar = float(clamp(ac[best_lag], 0.0, 1.0))
    rms = float(np.sqrt(np.mean(y * y) + 1e-12))
    rms_db = 20.0 * math.log10(max(1e-6, rms))
    thr = float(flux.mean() + 0.6 * flux.std())
    onsets = np.flatnonzero((flux[1:-1] > flux[:-2]) & (flux[1:-1] >= flux[2:]) & (flux[1:-1] > thr))
    onset_rate = float(len(onsets) / max(1.0, len(y) / SR))
    energy = int(round(clamp(1.0 + (rms_db + 26.0) / 2.6 + p_clar * 2.2 + min(2.0, onset_rate / 4.0), 1.0, 10.0)))
    return bpm, energy, round(p_clar, 3), round(onset_rate, 2)


def compute_drum_complexity(
    perc_share: float, perc_onset_rate: float, gap_cv: float, gap_ent: float, high_low_ratio: float, breakbeat_score: float = 0.0
) -> float:
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


def compute_groove_metrics(
    P: np.ndarray, P_p: np.ndarray, freqs: np.ndarray, fps: float, bpm_est: float, perc_share: float, gap_ent: float
) -> dict:
    if perc_share < 0.055 or P.shape[1] < 32:
        return {"four_on_floor": 0.0, "breakbeat_score": 0.0, "chop_var": 0.0, "groove_style": "ambient"}

    def band_flux(lo_hz: float, hi_hz: float, use_total_mix: bool = False) -> np.ndarray:
        m = (freqs >= lo_hz) & (freqs <= hi_hz)
        src = (0.55 * P_p[m] + 0.45 * P[m]) if use_total_mix else P_p[m]
        env = np.sqrt(src.sum(axis=0) + 1e-12)
        return np.maximum(0.0, np.diff(np.log1p(14.0 * env), prepend=0.0))

    fl_k = band_flux(35.0, 155.0, use_total_mix=True)
    fl_sn = band_flux(170.0, 2400.0, use_total_mix=False)
    fl_hh = band_flux(2400.0, 9000.0, use_total_mix=False)

    seg_len = min(len(fl_k), max(64, int(round(45.0 * fps))))
    tot_p = np.sqrt(P_p[(freqs >= 140.0) & (freqs <= 9000.0)].sum(axis=0) + 1e-12)
    if len(tot_p) > seg_len:
        cs = np.cumsum(np.insert(tot_p, 0, 0.0))
        best_s = int(np.argmax(cs[seg_len:] - cs[:-seg_len]))
    else:
        best_s = 0
    best_e = best_s + seg_len

    bar_sec = 240.0 / max(55.0, min(200.0, float(bpm_est)))
    block_frames = max(int(round(4.0 * max(16.0, bar_sec * fps))), 32)
    n_blocks = max(1, (best_e - best_s) // block_frames)
    K_acc, SN_acc, HH_acc = np.zeros(16), np.zeros(16), np.zeros(16)
    block_sigs = []

    for bi in range(n_blocks):
        a, b = best_s + bi * block_frames, min(best_e, best_s + (bi + 1) * block_frames)
        step_idx = np.floor(((np.arange(a, b) - a) / fps / bar_sec) * 16.0).astype(int) % 16
        cnts = np.maximum(1.0, np.bincount(step_idx, minlength=16).astype(np.float64))
        Kb = np.bincount(step_idx, weights=fl_k[a:b], minlength=16) / cnts
        SNb = np.bincount(step_idx, weights=fl_sn[a:b], minlength=16) / cnts
        HHb = np.bincount(step_idx, weights=fl_hh[a:b], minlength=16) / cnts
        block_sigs.append(Kb / (Kb.sum() + 1e-9))
        if bi == 0:
            K_ref, shift = Kb, 0
        else:
            shift = int(np.argmax([float(np.dot(np.roll(Kb, -sh), K_ref)) for sh in range(16)]))
        K_acc += np.roll(Kb, -shift)
        SN_acc += np.roll(SNb, -shift)
        HH_acc += np.roll(HHb, -shift)

    def sharpen(v: np.ndarray) -> np.ndarray:
        v0 = np.maximum(0.0, v - float(np.percentile(v, 20)))
        return v0 / (v0.sum() + 1e-9)

    Kp, SNp, HHp = sharpen(K_acc), sharpen(SN_acc), sharpen(HH_acc)
    best_q_phase = int(np.argmax([float(Kp[[p, p + 4, p + 8, p + 12]].sum()) for p in range(4)]))
    Kr, SNr = np.roll(Kp, -best_q_phase), np.roll(SNp, -best_q_phase)

    q_vals = np.sort(Kr[[0, 4, 8, 12]])
    q_total_share = float(q_vals.sum())
    q_min2_ratio = float((q_vals[0] + q_vals[1]) / (q_vals[2] + q_vals[3] + 1e-9))
    sync_kicks = float(Kr[[2, 3, 6, 7, 10, 11, 14, 15]].sum())
    ghost_richness = clamp((int(np.sum(SNr > (0.35 * float(np.max(SNr)) + 1e-9))) - 2) / 6.0, 0.0, 1.0)
    hat_16_density = clamp(float(np.sum(HHp > 0.25 * float(np.max(HHp)) + 1e-9)) / 12.0, 0.0, 1.0)
    chop_var = float(np.mean([
        1.0 - float(np.dot(block_sigs[i], block_sigs[i + 1]) / (np.linalg.norm(block_sigs[i]) * np.linalg.norm(block_sigs[i + 1]) + 1e-9))
        for i in range(len(block_sigs) - 1)
    ])) if len(block_sigs) >= 2 else 0.15

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
    return {"four_on_floor": four_on_floor, "breakbeat_score": breakbeat_score, "chop_var": round(chop_var, 3), "groove_style": g_style}


def compute_transient_and_guitar_dsp(
    P_h: np.ndarray, P_p: np.ndarray, P_tot: np.ndarray, freqs: np.ndarray, fps: float,
    perc_onset_rate: float, sub_share: float, bass_share: float, mid_share: float,
    high_share: float, modal_darkness: float, harmonic_complexity: float,
    harmonic_motion: float, bpm: float, raw_dc: float, raw_f4: float, raw_brk: float,
) -> dict:
    """Section 5.1 Dark Ambient transient gate + Section 5.2 Guitar/Vocal harmonic detector."""
    # 1. Transient sharpness / percussive crest over 1.5s local median + 110ms 6dB short-decay check
    p_tot_env = np.sqrt(P_p.sum(axis=0) + 1e-12)
    loc_med = median_filter(p_tot_env, size=max(15, int(round(1.5 * fps))))
    perc_crest = float(np.percentile(p_tot_env, 95) / (float(np.median(loc_med)) + 1e-5))
    pk_thr = float(np.percentile(p_tot_env, 82))
    pks = np.flatnonzero((p_tot_env[1:-1] > p_tot_env[:-2]) & (p_tot_env[1:-1] >= p_tot_env[2:]) & (p_tot_env[1:-1] > pk_thr)) + 1
    decay_fr = max(3, int(round(0.110 * fps)))
    sd_hits = [
        1.0 if float(np.min(p_tot_env[pk + 1 : pk + decay_fr + 1])) <= 0.55 * float(p_tot_env[pk]) else 0.0
        for pk in pks if pk + decay_fr < len(p_tot_env)
    ]
    short_decay_rate = float(np.mean(sd_hits)) if sd_hits else 0.0

    # Discrete sub-kick spikes (45-130 Hz) vs harmonic floor OR >= 1400 Hz crisp snare/hi-hat
    m_k = (freqs >= 45.0) & (freqs <= 130.0)
    k_p = np.sqrt(P_p[m_k].sum(axis=0) + 1e-12)
    k_h = np.sqrt(P_h[m_k].sum(axis=0) + 1e-12)
    k_vs_h = float(np.percentile(k_p, 95) / (float(np.median(k_h)) + 1e-4))
    m_crisp = freqs >= 1400.0
    crisp_perc_share = float(P_p[m_crisp].sum() / (P_tot[m_crisp].sum() + 1e-12))

    crest_conf = clamp((perc_crest - 1.40) / 1.05, 0.0, 1.0)
    decay_conf = clamp((short_decay_rate - 0.30) / 0.45, 0.0, 1.0)
    subk_ok = clamp((k_vs_h - 0.70) / 0.80, 0.0, 1.0)
    crisp_ok = clamp((crisp_perc_share - 0.06) / 0.35, 0.0, 1.0) * clamp((perc_onset_rate - 1.5) / 2.5, 0.0, 1.0)
    transient_conf = clamp(0.45 * crest_conf + 0.35 * decay_conf + 0.20 * max(subk_ok, crisp_ok), 0.0, 1.0)
    if perc_crest < 1.75 and short_decay_rate < 0.45:
        transient_conf = min(transient_conf, 0.16)

    # 2. Guitar & Vocal detector (180-2800 Hz string harmonic tail, mid dominance, 4-8 Hz vibrato)
    m_gv = (freqs >= 180.0) & (freqs <= 2800.0)
    eh, ep = P_h[m_gv].sum(axis=0), P_p[m_gv].sum(axis=0)
    etot = np.sqrt(eh + ep + 1e-12)
    fl_gv = np.maximum(0.0, np.diff(np.log1p(12.0 * etot), prepend=0.0))
    gv_pks = np.flatnonzero(
        (fl_gv[1:-1] > fl_gv[:-2]) & (fl_gv[1:-1] >= fl_gv[2:]) & (fl_gv[1:-1] > float(np.percentile(fl_gv, 75)))
    ) + 1
    tails = [float(np.mean(eh[pk + 1 : pk + 5]) / (ep[pk] + 1e-9)) for pk in gv_pks if pk + 4 < len(eh)]
    string_harmonic_ratio = float(np.median(tails)) if tails else 0.0
    gv_hp = float(P_h[m_gv].sum() / (P_p[m_gv].sum() + 1e-12))

    mid_dominance = float(mid_share / (sub_share + 0.05))
    m_sk, m_v = (freqs >= 35.0) & (freqs <= 100.0), (freqs >= 200.0) & (freqs <= 2400.0)
    low_kick_vs_tonal = float(np.percentile(np.sqrt(P_p[m_sk].sum(axis=0) + 1e-12), 90) / (float(np.median(np.sqrt(P_h[m_v].sum(axis=0) + 1e-12))) + 1e-5))
    hh_frac = float(P_p[freqs >= 3500.0].sum() / (P_tot.sum() + 1e-12))

    cent = np.sum(freqs[m_v][:, None] * (P_h[m_v] + 1e-12), axis=0) / np.sum(P_h[m_v] + 1e-12, axis=0)
    dc_c = 1200.0 * np.log2(np.maximum(150.0, cent) / 440.0)
    dc_c = dc_c - median_filter(dc_c, size=min(15, max(3, len(dc_c) // 2 * 2 + 1)))
    sp_c = np.abs(np.fft.rfft(dc_c * np.hanning(len(dc_c))))
    fc_c = np.fft.rfftfreq(len(dc_c), d=1.0 / fps)
    vib_mask = (fc_c >= 4.0) & (fc_c <= 8.0)
    all_mask = (fc_c >= 0.5) & (fc_c <= 15.0)
    vocal_vibrato = float(np.sum(sp_c[vib_mask] ** 2) / (np.sum(sp_c[all_mask] ** 2) + 1e-9)) if np.any(vib_mask) else 0.0

    # Guitar/vocal gate: active rhythmic strumming/singing, midrange presence, non-4/4, non-D&B
    beat_gate = clamp((raw_dc - 40.0) / 14.0, 0.0, 1.0) * clamp((raw_brk - 22.0) / 14.0, 0.0, 1.0)
    mid_gate = clamp((mid_share - 0.032) / 0.038, 0.0, 1.0)
    non_4x4 = clamp((28.0 - raw_f4) / 16.0, 0.0, 1.0)
    sub_restraint = clamp((0.44 - sub_share) / 0.14, 0.0, 1.0) * clamp((0.695 - (sub_share + bass_share)) / 0.10, 0.0, 1.0)
    not_dnb = clamp((158.0 - bpm) / 10.0, 0.0, 1.0) * clamp((0.022 - hh_frac) / 0.012, 0.0, 1.0)
    s_shr = clamp((math.log1p(string_harmonic_ratio) - 0.55) / 1.4, 0.0, 1.0)
    s_gvhp = clamp((math.log1p(gv_hp) - 0.60) / 1.2, 0.0, 1.0)
    s_mid = clamp((mid_dominance - 0.12) / 1.1, 0.0, 1.0) * clamp((1.6 - low_kick_vs_tonal) / 1.3, 0.0, 1.0)
    s_vib = clamp((vocal_vibrato - 0.25) / 0.20, 0.0, 1.0)
    s_hybrid = (
        clamp((harmonic_complexity - 44.0) / 36.0, 0.0, 1.0)
        * clamp((harmonic_motion - 50.0) / 40.0, 0.0, 1.0)
        * clamp((raw_dc - 44.0) / 18.0, 0.0, 1.0)
        * clamp((raw_brk - 30.0) / 18.0, 0.0, 1.0)
    )
    gv_raw = max(0.38 * s_shr + 0.24 * s_gvhp + 0.22 * s_mid + 0.16 * s_vib, 0.98 * s_hybrid)
    # Boost strong acoustic/vocal signals into clean 55-85 band
    gv_boosted = math.sqrt(max(0.0, gv_raw)) if gv_raw > 0 else 0.0
    guitar_vocal_score = round(clamp(100.0 * beat_gate * mid_gate * non_4x4 * max(0.55, sub_restraint) * not_dnb * gv_boosted), 1)
    if (sub_share + bass_share) >= 0.69 or raw_dc < 45.0 or raw_brk < 30.0:
        guitar_vocal_score = 0.0

    # Gate drum metrics by transient_conf (preserve plucked-guitar tracks with high guitar_vocal_score)
    if transient_conf < 0.55 and guitar_vocal_score < 35.0:
        dc_gated = round(raw_dc * (0.06 + 0.94 * (transient_conf ** 1.15)), 1)
    elif guitar_vocal_score >= 35.0:
        dc_gated = round(max(min(raw_dc, 38.0), raw_dc * (0.50 + 0.50 * transient_conf)), 1)
    else:
        dc_gated = round(raw_dc, 1)

    f4_gated = round(raw_f4 * (transient_conf ** 1.4), 1)
    brk_gated = raw_brk * (transient_conf ** 1.4)
    breakbeat_score = round(clamp(brk_gated * (1.0 - 0.65 * (guitar_vocal_score / 100.0))), 1)

    # 3. Dark Ambient Score (0..100): high low-end sub+bass weight + modal darkness + low high shimmer
    low_end_w = clamp((sub_share + bass_share - 0.50) / 0.22, 0.0, 1.0)
    drum_pres = clamp(dc_gated / 28.0, 0.0, 1.0)
    hi_norm = clamp(high_share / 0.04, 0.0, 1.0)
    dark_ambient_score = round(clamp(100.0 * (1.0 - drum_pres) * (0.58 * low_end_w + 0.22 * (modal_darkness / 100.0) + 0.20 * (1.0 - hi_norm))), 1)

    if guitar_vocal_score >= 45.0:
        g_style = "guitar_vocal"
    elif dc_gated < 20.0 and dark_ambient_score >= 28.0:
        g_style = "dark_ambient"
    elif dc_gated < 20.0:
        g_style = "ambient"
    elif f4_gated >= breakbeat_score + 6.0 and f4_gated >= 36.0:
        g_style = "four_on_floor"
    elif breakbeat_score >= f4_gated + 4.0 and breakbeat_score >= 34.0:
        g_style = "breakbeat"
    else:
        g_style = "downtempo"

    return {
        "transient_conf": round(transient_conf, 3),
        "perc_crest": round(perc_crest, 2),
        "drum_complexity": dc_gated,
        "four_on_floor": f4_gated,
        "breakbeat_score": breakbeat_score,
        "dark_ambient_score": dark_ambient_score,
        "guitar_vocal_score": guitar_vocal_score,
        "groove_style": g_style,
    }


def analyze_harmony_and_rhythm(
    y: np.ndarray, bpm_est: float, existing_bands: dict | None = None, full_track_baseline: dict | None = None
) -> dict:
    """Compute STFT/HPSS chromagram, groove metrics, Dark Ambient gate, and Guitar/Vocal score."""
    sr = float(SR)
    nfft, hop = 2048, 512
    nfr = 1 + max(0, (len(y) - nfft) // hop)
    if nfr < 24:
        return {
            "key_camelot": "5A", "key_label": "Cm (5A)", "chord_richness": 45.0, "harmonic_motion": 40.0,
            "modal_darkness": 50.0, "microtonal_score": 15.0, "harmonic_complexity": 45.0,
            "drum_complexity": 14.0, "perc_share": 0.04, "perc_onset_rate": 1.0,
            "gap_cv": 0.2, "gap_entropy": 0.1, "high_low_ratio": 0.3,
            "four_on_floor": 0.0, "breakbeat_score": 0.0, "dark_ambient_score": 40.0,
            "guitar_vocal_score": 0.0, "transient_conf": 0.2, "perc_crest": 1.2,
            "groove_style": "ambient", "scale_deg_12": [round(1 / 12, 4)] * 12,
            "sub_share": 0.25, "bass_share": 0.25, "mid_share": 0.10, "high_share": 0.02, "air_share": 0.0,
        }

    win = np.hanning(nfft).astype(np.float32)
    frames = [
        np.abs(np.fft.rfft(y[np.arange(nfft)[None, :] + hop * np.arange(s0, min(nfr, s0 + 512))[:, None]] * win, axis=1)).astype(np.float32)
        for s0 in range(0, nfr, 512)
    ]
    S = np.vstack(frames).T
    S_h = median_filter(S, size=(1, 17))
    S_p = median_filter(S, size=(17, 1))
    denom = S_h ** 2 + S_p ** 2 + 1e-12
    P_h = (S * (S_h ** 2 / denom)) ** 2
    P_p = (S * (S_p ** 2 / denom)) ** 2
    P_tot = P_h + P_p + 1e-12
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)

    if existing_bands:
        sub_share = float(existing_bands["sub_share"])
        bass_share = float(existing_bands["bass_share"])
        mid_share = float(existing_bands["mid_share"])
        high_share = float(existing_bands["high_share"])
        air_share = float(existing_bands["air_share"])
    else:
        tot_e = float(P_tot.sum() + 1e-12)
        sub_share = round(float(P_tot[(freqs >= 20) & (freqs < 80)].sum() / tot_e), 3)
        bass_share = round(float(P_tot[(freqs >= 80) & (freqs < 250)].sum() / tot_e), 3)
        mid_share = round(float(P_tot[(freqs >= 250) & (freqs < 2500)].sum() / tot_e), 3)
        high_share = round(float(P_tot[(freqs >= 2500) & (freqs < 6000)].sum() / tot_e), 3)
        air_share = round(float(P_tot[freqs >= 6000].sum() / tot_e), 3)

    m_hi = (freqs >= 160.0) & (freqs <= 9000.0)
    m_lo = (freqs >= 45.0) & (freqs < 160.0)
    perc_share = 0.82 * float(P_p[m_hi].sum() / (P_tot[m_hi].sum() + 1e-12)) + 0.18 * float(P_p[m_lo].sum() / (P_tot[m_lo].sum() + 1e-12))

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

    peak_dev = np.average(dev_st[:, None] * np.ones((1, P_sub.shape[1])), weights=P_sub + 1e-12)
    microtonal_score = clamp((float(peak_dev) - 0.14) / 0.18 * 100.0)

    mean_c = chroma.mean(axis=1)
    mean_c_z = (mean_c - mean_c.mean()) / (mean_c.std() + 1e-9) if mean_c.sum() > 0 else np.ones(12) / 12.0
    best_corr, tonic_pc, is_minor = -999.0, 0, True
    for k in range(12):
        maj_rot, min_rot = np.roll(KS_MAJOR, k), np.roll(KS_MINOR, k)
        c_maj = float(np.dot(mean_c_z, (maj_rot - maj_rot.mean()) / maj_rot.std()))
        c_min = float(np.dot(mean_c_z, (min_rot - min_rot.mean()) / min_rot.std()))
        if c_maj > best_corr:
            best_corr, tonic_pc, is_minor = c_maj, k, False
        if c_min > best_corr:
            best_corr, tonic_pc, is_minor = c_min, k, True

    key_camelot = CAMELOT_MINOR[tonic_pc] if is_minor else CAMELOT_MAJOR[tonic_pc]
    key_name = NOTE_PC_MINOR[tonic_pc] if is_minor else NOTE_PC_MAJOR[tonic_pc]
    rot_mean = np.roll(mean_c, -tonic_pc)
    rot_norm = rot_mean / (rot_mean.sum() + 1e-12)

    dark_mass = float(1.4 * rot_norm[1] + 1.2 * rot_norm[3] + 1.2 * rot_norm[6] + 1.1 * rot_norm[8] + 0.7 * rot_norm[10])
    bright_mass = float(0.8 * rot_norm[2] + 1.3 * rot_norm[4] + 1.0 * rot_norm[9] + 1.0 * rot_norm[11])
    modal_darkness = clamp((dark_mass / (dark_mass + bright_mass + 1e-9) - 0.18) / 0.62 * 100.0)
    if is_minor:
        modal_darkness = clamp(0.75 * modal_darkness + 22.0)

    fps = sr / hop
    win_frames = max(8, int(round((240.0 / max(60.0, min(180.0, bpm_est))) * fps)))
    n_win = chroma.shape[1] // win_frames
    if n_win < 2:
        win_frames = max(4, chroma.shape[1] // 4)
        n_win = chroma.shape[1] // max(1, win_frames)
    e_thresh = float(np.percentile(chroma.sum(axis=0), 20)) * 0.5
    win_vecs = [
        seg.sum(axis=1) / (seg.sum() + 1e-12)
        for w in range(n_win)
        if (seg := chroma[:, w * win_frames : (w + 1) * win_frames]).sum() > e_thresh * win_frames
    ]
    if win_vecs:
        W = np.array(win_vecs)
        eff_pcs = [math.exp(-float(np.sum(vn[vn > 1e-4] * np.log(vn[vn > 1e-4])))) for vn in W]
        chord_richness = clamp((float(np.median(eff_pcs)) - 3.2) / 6.2 * 100.0)
        if len(W) >= 2:
            cos_sims = [1.0 - float(np.dot(W[i], W[i + 1]) / (np.linalg.norm(W[i]) * np.linalg.norm(W[i + 1]) + 1e-9)) for i in range(len(W) - 1)]
            root_rate = sum(int(np.argmax(W[i])) != int(np.argmax(W[i + 1])) for i in range(len(W) - 1)) / max(1, len(W) - 1)
            harmonic_motion = clamp(0.65 * (float(np.mean(cos_sims)) / 0.28 * 100.0) + 0.35 * (root_rate * 100.0))
        else:
            harmonic_motion = 20.0
    else:
        chord_richness, harmonic_motion = 35.0, 25.0
    harmonic_complexity = clamp(0.42 * chord_richness + 0.35 * harmonic_motion + 0.23 * modal_darkness)

    p_env_low = P_p[(freqs >= 25.0) & (freqs < 200.0), :].sum(axis=0)
    p_env_high = P_p[(freqs >= 250.0) & (freqs < 8000.0), :].sum(axis=0)
    p_tot_env = np.sqrt(P_p.sum(axis=0) + 1e-12)
    flux_p = np.maximum(0.0, np.diff(np.log1p(12.0 * p_tot_env), prepend=0.0))
    thr_p = float(flux_p.mean() + 0.6 * flux_p.std())
    onsets_idx = np.flatnonzero((flux_p[1:-1] > flux_p[:-2]) & (flux_p[1:-1] >= flux_p[2:]) & (flux_p[1:-1] > thr_p)) + 1
    perc_onset_rate = len(onsets_idx) / max(1.0, len(y) / sr)

    if len(onsets_idx) >= 4:
        gaps = np.diff(onsets_idx) / fps
        gap_cv = float(np.std(gaps) / (np.mean(gaps) + 1e-9))
        q_gaps = np.round(np.clip(gaps * (bpm_est / 60.0) * 4.0, 1, 16)).astype(int)
        _, cnts = np.unique(q_gaps, return_counts=True)
        pr = cnts / cnts.sum()
        gap_ent = float(-(pr * np.log(pr)).sum() / math.log(8.0))
    else:
        gap_cv, gap_ent = 0.2, 0.1

    high_low_ratio = float(p_env_high.mean() / (p_env_low.mean() + p_env_high.mean() + 1e-9))
    groove = compute_groove_metrics(S ** 2, P_p, freqs, fps, bpm_est, perc_share, gap_ent)
    raw_dc = compute_drum_complexity(perc_share, perc_onset_rate, gap_cv, gap_ent, high_low_ratio, groove["breakbeat_score"])
    raw_f4 = groove["four_on_floor"]
    raw_brk = groove["breakbeat_score"]
    hc_val, cr_val, hm_val, md_val = harmonic_complexity, chord_richness, harmonic_motion, modal_darkness
    if full_track_baseline:
        raw_dc = float(full_track_baseline.get("drum_complexity", raw_dc))
        raw_f4 = float(full_track_baseline.get("four_on_floor", raw_f4))
        raw_brk = float(full_track_baseline.get("breakbeat_score", raw_brk))
        hc_val = float(full_track_baseline.get("harmonic_complexity", hc_val))
        cr_val = float(full_track_baseline.get("chord_richness", cr_val))
        hm_val = float(full_track_baseline.get("harmonic_motion", hm_val))
        md_val = float(full_track_baseline.get("modal_darkness", md_val))
        perc_share = float(full_track_baseline.get("perc_share", perc_share))
        perc_onset_rate = float(full_track_baseline.get("perc_onset_rate", perc_onset_rate))
        gap_cv = float(full_track_baseline.get("gap_cv", gap_cv))
        gap_ent = float(full_track_baseline.get("gap_entropy", gap_ent))
        high_low_ratio = float(full_track_baseline.get("high_low_ratio", high_low_ratio))

    gated = compute_transient_and_guitar_dsp(
        P_h, P_p, P_tot, freqs, fps, perc_onset_rate,
        sub_share, bass_share, mid_share, high_share,
        md_val, hc_val, hm_val, bpm_est,
        raw_dc, raw_f4, raw_brk,
    )

    out_hr = {
        "key_camelot": key_camelot, "key_label": f"{key_name} ({key_camelot})",
        "chord_richness": round(cr_val, 1), "harmonic_motion": round(hm_val, 1),
        "modal_darkness": round(md_val, 1), "microtonal_score": round(microtonal_score, 1),
        "harmonic_complexity": round(hc_val, 1),
        "perc_share": round(perc_share, 3), "perc_onset_rate": round(perc_onset_rate, 2),
        "gap_cv": round(gap_cv, 3), "gap_entropy": round(gap_ent, 3),
        "high_low_ratio": round(high_low_ratio, 3),
        "scale_deg_12": [round(float(x), 4) for x in rot_norm],
        "sub_share": sub_share, "bass_share": bass_share, "mid_share": mid_share,
        "high_share": high_share, "air_share": air_share,
        **gated,
    }
    if full_track_baseline:
        for keep_k in ("key_camelot", "key_label", "microtonal_score", "scale_deg_12"):
            if keep_k in full_track_baseline:
                out_hr[keep_k] = full_track_baseline[keep_k]
    return out_hr


def make_tags(t: dict) -> tuple[str, str]:
    cr, hm, md, ms = t["chord_richness"], t["harmonic_motion"], t["modal_darkness"], t["microtonal_score"]
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

    dc, en, bpm = t["drum_complexity"], t["energy"], t["bpm"]
    f4, brk = float(t.get("four_on_floor", 0.0)), float(t.get("breakbeat_score", 0.0))
    if t.get("guitar_vocal_score", 0.0) >= 45.0:
        r_tag = "Guitar & vocal phrasing"
    elif dc < 20 and t.get("dark_ambient_score", 0.0) >= 28.0:
        r_tag = "Dark ambient drone"
    elif dc < 24 and t["perc_share"] < 0.08:
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
    dc = float(t.get("drum_complexity", 0.0))
    r_conf = clamp((dc - 16.0) / 14.0, 0.0, 1.0)
    return round(r_conf * float(t["bpm"]) + (1.0 - r_conf) * 68.0, 2)


def cluster_and_layout(tracks: list[dict]) -> dict:
    """Cluster tracks into the canonical 8 Vibe groups and project Vibe + Energy-Wave Era coords."""
    for t in tracks:
        t["effective_bpm"] = effective_tempo(t)
        pul_presence = clamp((float(t.get("perc_share", 0.0)) - 0.02) / 0.10, 0.0, 1.0) * float(t.get("transient_conf", 1.0))
        t["drum_pulse"] = round(float(t.get("pulse_clarity", 0.0)) * pul_presence * 100.0, 1)

    # Standardize continuous features + add bounded sparse detectors so N=557 z-scores stay balanced
    dense_w = np.array([1.85, 2.85, 1.85, 4.45, 2.65, 0.55, 0.40, 0.30, 0.30, 0.90])
    X_dense = np.array([
        [
            t["energy"], t["effective_bpm"], t["drum_complexity"],
            t.get("breakbeat_score", 0.0), t.get("four_on_floor", 0.0),
            t["harmonic_complexity"], t["chord_richness"], t["harmonic_motion"],
            t["modal_darkness"], t.get("microtonal_score", 0.0),
        ]
        for t in tracks
    ], dtype=np.float64)
    da_col = np.clip(np.array([t.get("dark_ambient_score", 0.0) for t in tracks]) / 18.0, 0.0, 3.2)[:, None] * 4.2
    gv_arr = np.array([t.get("guitar_vocal_score", 0.0) for t in tracks])
    gv_col = (np.clip(gv_arr / 14.0, 0.0, 3.5) * 5.0 + (gv_arr >= 32.0).astype(np.float64) * 5.5)[:, None]
    X_std = np.hstack([StandardScaler().fit_transform(X_dense) * dense_w, da_col, gv_col])
    D = np.linalg.norm(X_std[:, None, :] - X_std[None, :, :], axis=2)

    n_sub = 44 if len(tracks) > 120 else 8
    sub_labels = AgglomerativeClustering(n_clusters=n_sub, linkage="ward").fit_predict(X_std)
    if n_sub == 8:
        for cid in range(n_sub):
            members = [i for i, lbl in enumerate(sub_labels) if lbl == cid]
            if len(members) == 1:
                idx0 = members[0]
                other = [c for c in range(n_sub) if c != cid and np.sum(sub_labels == c) >= 2]
                if other:
                    best_c = min(other, key=lambda c: float(np.linalg.norm(X_std[idx0] - X_std[sub_labels == c].mean(axis=0))))
                    sub_labels[idx0] = best_c
                    largest = max(other, key=lambda c: int(np.sum(sub_labels == c)))
                    l_idxs = [i for i, lbl in enumerate(sub_labels) if lbl == largest]
                    if len(l_idxs) >= 4:
                        s2 = AgglomerativeClustering(n_clusters=2, linkage="ward").fit_predict(X_std[l_idxs])
                        for k_i, ti in enumerate(l_idxs):
                            if s2[k_i] == 1:
                                sub_labels[ti] = cid

    def _stats(idxs: list[int]) -> dict:
        return {
            "en": float(np.mean([tracks[i]["energy"] for i in idxs])),
            "bpm": float(np.mean([tracks[i]["effective_bpm"] for i in idxs])),
            "dc": float(np.mean([tracks[i]["drum_complexity"] for i in idxs])),
            "brk": float(np.mean([tracks[i].get("breakbeat_score", 0.0) for i in idxs])),
            "f4": float(np.mean([tracks[i].get("four_on_floor", 0.0) for i in idxs])),
            "da": float(np.mean([tracks[i].get("dark_ambient_score", 0.0) for i in idxs])),
            "gv": float(np.mean([tracks[i].get("guitar_vocal_score", 0.0) for i in idxs])),
            "cr": float(np.mean([tracks[i]["chord_richness"] for i in idxs])),
            "micro": float(np.mean([tracks[i]["microtonal_score"] for i in idxs])),
        }

    archetypes = [
        ("ambient", "Ambient & meditative", lambda c: (320.0 if c["dc"] < 24 and c["da"] < 38 and c["gv"] < 25 else -300.0) + (10 - c["en"]) * 3.0 - c["da"] * 1.6 - c["dc"] * 0.7),
        ("dark_ambient", "Dark ambient & drone", lambda c: (340.0 if c["dc"] < 24 and c["da"] >= 38 else -300.0) + c["da"] * 3.0 - c["dc"] * 0.9 - c["gv"]),
        ("downtempo_lush", "Downtempo & lush chords", lambda c: (160.0 if c["dc"] >= 20 and c["f4"] < 44 and c["brk"] < 32 and c["gv"] < 25 and c["bpm"] >= 98 else 0.0) + c["cr"] * 0.7 - c["en"] * 3.5 - c["brk"] * 0.5),
        ("chill_elec", "Chill & steady electronic", lambda c: (165.0 if c["dc"] >= 20 and c["bpm"] < 104 and c["f4"] < 50 and c["brk"] < 38 and c["gv"] < 25 else 0.0) + (110.0 - c["bpm"]) * 1.1 - c["f4"] * 0.35 - c["brk"] * 0.4),
        ("guitar_vocal", "Experimental guitar & vocal", lambda c: (360.0 if c["gv"] >= 30 else -300.0) + c["gv"] * 4.5 - c["f4"] * 0.5),
        ("hypnotic_micro", "Hypnotic electro & microtonal", lambda c: (155.0 if 95 <= c["bpm"] < 146 and c["dc"] >= 42 and c["brk"] < 46 and c["f4"] < 54 and c["gv"] < 25 else 0.0) + c["dc"] * 0.6 + c["micro"] * 1.1 - c["brk"] * 0.25),
        ("house_ecstatic", "House & ecstatic 4/4 groove", lambda c: (175.0 if c["f4"] >= 50 and c["dc"] >= 38 else 0.0) + c["f4"] * 1.9 + c["en"] * 3.0 - c["brk"] * 0.6),
        ("dnb_breaks", "Complex drums & breaks", lambda c: (185.0 if c["brk"] >= 44 and c["f4"] < 48 and c["gv"] < 28 else 0.0) + c["brk"] * 2.6 + c["dc"] * 1.1 + c["bpm"] * 0.35 - c["f4"] * 0.8 - c["gv"] * 1.8),
    ]
    sub_clusters = [{"sid": sid, "idxs": [i for i, l in enumerate(sub_labels) if l == sid]} for sid in range(n_sub)]
    for sc in sub_clusters:
        sc.update(_stats(sc["idxs"]))
    # First guarantee every archetype has at least 1 best-matching subcluster
    pairs = [(fn(sc), sc["sid"], aid, alabel) for sc in sub_clusters for aid, alabel, fn in archetypes]
    pairs.sort(reverse=True)
    sid_to_arch, used_a = {}, set()
    for _, sid, aid, alabel in pairs:
        if sid not in sid_to_arch and aid not in used_a:
            sid_to_arch[sid] = (aid, alabel)
            used_a.add(aid)
    # Assign all remaining subclusters cleanly to their highest-scoring physical territory
    for sc in sub_clusters:
        if sc["sid"] not in sid_to_arch:
            best_aid, best_alabel = max(archetypes, key=lambda a: a[2](sc))[:2]
            sid_to_arch[sc["sid"]] = (best_aid, best_alabel)

    arch_members: dict[str, list[int]] = {}
    arch_labels = {aid: alabel for aid, alabel, _ in archetypes}
    for sc in sub_clusters:
        aid = sid_to_arch[sc["sid"]][0]
        arch_members.setdefault(aid, []).extend(sc["idxs"])

    canonical_order = ["ambient", "dark_ambient", "downtempo_lush", "chill_elec", "guitar_vocal", "hypnotic_micro", "house_ecstatic", "dnb_breaks"]
    orig_to_name = {idx: (aid, arch_labels[aid]) for idx, aid in enumerate(canonical_order)}
    clusters_raw = [{"orig_id": idx, "idxs": arch_members[aid], **_stats(arch_members[aid])} for idx, aid in enumerate(canonical_order)]
    merged_labels = np.zeros(len(tracks), dtype=int)
    for c in clusters_raw:
        for i in c["idxs"]:
            merged_labels[i] = c["orig_id"]
    sil = float(silhouette_score(X_std, merged_labels))
    T_PALETTE_HUES = [205, 245, 165, 275, 24, 38, 130, 340]

    perp = min(22, max(6, len(tracks) // 16)) if len(tracks) > 100 else min(14, max(5, len(tracks) // 5))
    xy = TSNE(n_components=2, perplexity=perp, init="pca", learning_rate="auto", random_state=42).fit_transform(X_std)
    xy = (xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0) + 1e-9)

    # Pull Dark Ambient centroid smoothly adjacent to Ambient & meditative
    amb_idxs = next((c["idxs"] for c in clusters_raw if orig_to_name[c["orig_id"]][0] == "ambient"), [])
    da_idxs = next((c["idxs"] for c in clusters_raw if orig_to_name[c["orig_id"]][0] == "dark_ambient"), [])
    if amb_idxs and da_idxs:
        amb_cent = xy[amb_idxs].mean(axis=0)
        da_cent = xy[da_idxs].mean(axis=0)
        target_cent = np.clip(amb_cent + np.array([0.085, 0.055]), 0.10, 0.90)
        xy[da_idxs] = xy[da_idxs] - da_cent + target_cent

    for c in clusters_raw:
        cent = xy[c["idxs"]].mean(axis=0)
        xy[c["idxs"]] = 0.78 * xy[c["idxs"]] + 0.22 * cent

    min_sep = 0.036 if len(tracks) <= 100 else 0.017
    for _ in range(45):
        diff = xy[:, None, :] - xy[None, :, :]
        dist = np.hypot(diff[:, :, 0], diff[:, :, 1])
        mask = (dist > 1e-6) & (dist < min_sep)
        if not np.any(mask):
            break
        push = np.where(mask, (min_sep - dist) * 0.36 / np.maximum(dist, 1e-6), 0.0)
        xy += np.sum(diff * push[:, :, None], axis=1)
    xy = 0.07 + 0.86 * ((xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0) + 1e-9))

    style_groups = []
    for gi, c in enumerate(clusters_raw):
        aid, alabel = orig_to_name[c["orig_id"]]
        gid = f"s{gi}_{aid}"
        member_ids = [tracks[i]["id"] for i in c["idxs"]]
        for i in c["idxs"]:
            tracks[i]["cluster_id"] = gid
            tracks[i]["cluster_label"] = alabel
            tracks[i]["cluster_idx"] = gi
            h_tag, r_tag = make_tags(tracks[i])
            tracks[i]["harmony_tag"], tracks[i]["rhythm_tag"] = h_tag, r_tag

        cent = xy[c["idxs"]].mean(axis=0)
        min_x, max_x = float(np.min(xy[c["idxs"], 0])), float(np.max(xy[c["idxs"], 0]))
        min_y, max_y = float(np.min(xy[c["idxs"], 1])), float(np.max(xy[c["idxs"], 1]))
        pref_x, pref_y = float(cent[0]), max(0.055, min_y - 0.048)
        candidates = [
            (pref_x, pref_y),
            (float(cent[0]), min(0.94, max_y + 0.052)),
            (max(0.13, min_x - 0.02), max(0.055, min_y - 0.046)),
            (min(0.87, max_x + 0.02), max(0.055, min_y - 0.046)),
            (max(0.13, min_x - 0.02), min(0.94, max_y + 0.050)),
            (min(0.87, max_x + 0.02), min(0.94, max_y + 0.050)),
        ]

        def _pen(cand: tuple[float, float]) -> float:
            cx_c, cy_c = min(0.87, max(0.13, cand[0])), min(0.94, max(0.055, cand[1]))
            dot_p = sum(
                20.0 * (1.0 - max(abs(float(xy[k, 0]) - cx_c) / 0.11, abs(float(xy[k, 1]) - cy_c) / 0.038))
                for k in range(len(xy)) if abs(float(xy[k, 0]) - cx_c) < 0.11 and abs(float(xy[k, 1]) - cy_c) < 0.038
            )
            grp_p = sum(
                60.0 * (1.0 - max(abs(g["cx"] - cx_c) / 0.22, abs(g["cy"] - cy_c) / 0.075))
                for g in style_groups if abs(g["cx"] - cx_c) < 0.22 and abs(g["cy"] - cy_c) < 0.075
            )
            return dot_p + grp_p + 0.15 * math.hypot(cx_c - pref_x, cy_c - pref_y)

        bx, by = min(candidates, key=_pen)
        style_groups.append({
            "id": gid, "label": alabel, "idx": gi, "hue": T_PALETTE_HUES[gi % len(T_PALETTE_HUES)],
            "members": member_ids, "cx": round(min(0.87, max(0.13, bx)), 4), "cy": round(min(0.94, max(0.055, by)), 4),
        })

    scale = float(np.median(D[D > 0])) or 1.0
    track_near = {
        t["id"]: [[tracks[j]["id"], round(float(math.exp(-D[i, j] / scale)), 3)] for j in np.argsort(D[i]) if j != i][:4]
        for i, t in enumerate(tracks)
    }

    # Energy-Wave Era layout (X = chronological era 0..1, Y = Energy inverted so E8 crests upward)
    track_map, era_anchors = {}, []
    era_to_indices: dict[str, list[int]] = {eid: [] for eid in ERA_ORDER}
    for i, t in enumerate(tracks):
        era_to_indices.setdefault(t["era"], []).append(i)

    n_eras = len(ERA_ORDER)
    era_sep = 0.022 if len(tracks) <= 100 else 0.012
    for e_idx, eid in enumerate(ERA_ORDER):
        cx = 0.045 + (e_idx / max(1, n_eras - 1)) * 0.91
        members = sorted(era_to_indices.get(eid, []), key=lambda idx: (tracks[idx]["energy"], tracks[idx]["slot"]))
        coords = []
        cols = 5 if len(members) > 12 else max(1, len(members))
        for k, ti in enumerate(members):
            en_norm = clamp((float(tracks[ti]["energy"]) - 1.0) / 8.0, 0.0, 1.0)
            ey = 0.84 - en_norm * 0.68
            ex = cx + ((k % cols) - (cols - 1) / 2.0) * (0.006 if cols > 1 else 0.0)
            coords.append([ti, ex, ey])
        if len(coords) > 1:
            pts = np.array([[c[1], c[2]] for c in coords], dtype=np.float64)
            for _ in range(20):
                diff = pts[:, None, :] - pts[None, :, :]
                dist = np.hypot(diff[:, :, 0], diff[:, :, 1])
                mask = (dist > 1e-6) & (dist < era_sep)
                if not np.any(mask):
                    break
                push = np.where(mask, (era_sep - dist) * 0.45 / np.maximum(dist, 1e-6), 0.0)
                pts += np.sum(diff * push[:, :, None], axis=1)
            for idx_c, c in enumerate(coords):
                c[1], c[2] = float(pts[idx_c, 0]), float(pts[idx_c, 1])
        for ti, ex, ey in coords:
            v_pos = [round(float(xy[ti, 0]), 4), round(float(xy[ti, 1]), 4)]
            track_map[tracks[ti]["id"]] = {
                "vibe": v_pos, "similarity": v_pos,
                "era": [round(clamp(ex, 0.02, 0.98), 4), round(clamp(ey, 0.08, 0.92), 4)],
            }
        mean_ey = float(np.mean([c[2] for c in coords])) if coords else 0.50
        era_anchors.append({"id": eid, "idx": e_idx, "x": round(cx, 4), "y": 0.90, "cx": round(cx, 4), "cy": round(mean_ey, 4)})

    return {"silhouette": round(sil, 3), "style_groups": style_groups, "track_map": track_map, "era_anchors": era_anchors, "track_near": track_near}


def enrich_track_tiers(t: dict, rel_repo: str = "BillTribble/music-map") -> None:
    """Attach year, released, is_sketch, tier, links, and archive download metadata."""
    tid, era = t["id"], t["era"]
    year = int(t.get("year") or PRE_2015_OVERRIDES.get(tid) or ERA_DEFAULT_YEAR.get(era, 2020))
    rel_match = rc.match_released_track(t["title"], t.get("rel_path", ""), era)
    released = bool(rel_match is not None)
    links = dict(rel_match["links"]) if rel_match else {}
    if rel_match:
        year = int(rel_match["year"])
    full_dur = t.get("full_duration_sec")
    is_sketch = bool(
        t.get("is_sketch")
        or (full_dur is not None and float(full_dur) < 120.0)
        or (not released and (era in ("sketches_2024_25", "sketches_2026") or SKETCH_RE.search(t["title"])))
    )
    tier = "released" if released else ("archive_dl" if year < 2015 else "request")
    t.update({"year": year, "released": released, "is_sketch": is_sketch, "tier": tier})
    if links:
        t["links"] = links
    else:
        t.pop("links", None)
    if tier == "archive_dl":
        slug = t.get("slug") or re.sub(r"[^A-Za-z0-9]+", "_", t["title"]).strip("_")[:72]
        t["mp3_320_url"] = t.get("mp3_320_url") or f"https://github.com/{rel_repo}/releases/download/archive-downloads-v1/Bill_Tribble_-_{slug}.mp3"
        t["has_lossless"] = bool(t.get("has_lossless", False))
        t["dl_ready"] = bool(t.get("dl_ready", False))
    t["preview_release_url"] = f"https://github.com/{rel_repo}/releases/download/audio-previews-v1/{tid}.mp3"


def reanalyze_track_worker(ffmpeg_bin: str, base_dir: Path, t_in: dict) -> dict:
    t = dict(t_in)
    baseline_clip = base_dir / "audio" / f"{t['id']}.mp3"
    is_baseline = "drum_complexity" in t and "breakbeat_score" in t and baseline_clip.exists()
    if is_baseline:
        src, start_s, dur_s = baseline_clip, 0.0, 240.0
    else:
        src = Path(t["local_path"]) if t.get("local_path") else (base_dir / t["file"])
        full_dur = float(t.get("full_duration_sec") or 0.0)
        start_s = round(full_dur * 0.25, 2) if full_dur > 300.0 else 0.0
        dur_s = 180.0
    try:
        y = decode_audio(ffmpeg_bin, src, start_s=start_s, dur_s=dur_s)
    except Exception as exc:
        print(f"[WARN] decode failed for {t['id']} ({src}): {exc}", file=sys.stderr)
        y = np.zeros(SR * 4, dtype=np.float32)
    if "bpm" in t and "energy" in t:
        bpm = float(t["bpm"])
        bands = {k: t[k] for k in ("sub_share", "bass_share", "mid_share", "high_share", "air_share") if k in t}
        baseline = t if is_baseline else None
        hr = analyze_harmony_and_rhythm(y, bpm, existing_bands=bands if len(bands) == 5 else None, full_track_baseline=baseline)
    else:
        bpm, energy, p_clar, onset_rate = estimate_bpm_and_energy(y)
        t["bpm"], t["energy"], t["energy_source"] = bpm, energy, "dsp_model"
        t["pulse_clarity"], t["onset_rate"] = p_clar, onset_rate
        hr = analyze_harmony_and_rhythm(y, bpm)
    t.update(hr)
    enrich_track_tiers(t)
    return t


def main() -> None:
    ap = argparse.ArgumentParser(description="Analyze corpus audio and build 8-cluster Vibe + Era layout.")
    ap.add_argument("--reanalyze-local", action="store_true", help="Re-analyze local audio/*.mp3 merged with js/data.js")
    ap.add_argument("--data-js", type=Path, default=ROOT / "js" / "data.js")
    ap.add_argument("--manifest", type=Path, default=None, help="Optional catalog_manifest.json for full corpus analysis")
    ap.add_argument("--cache-json", type=Path, default=None, help="Optional path to cache raw DSP tracks before clustering")
    ap.add_argument("--from-cache", type=Path, default=None, help="Optional cached raw DSP JSON to skip audio decoding")
    ap.add_argument("--out-json", type=Path, default=SCRIPTS_DIR / "track_analysis.json")
    ap.add_argument("--workers", type=int, default=min(16, os.cpu_count() or 4))
    args = ap.parse_args()

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise SystemExit("ffmpeg not found on PATH")

    base_payload: dict = {}
    if args.data_js.exists():
        raw = args.data_js.read_text(encoding="utf-8")
        if "window.CORPUS_DATA = " in raw:
            base_payload = json.loads(raw.split("window.CORPUS_DATA = ", 1)[1].rstrip().rstrip(";"))

    if args.from_cache and args.from_cache.exists():
        analyzed = json.loads(args.from_cache.read_text(encoding="utf-8"))
        for t in analyzed:
            enrich_track_tiers(t)
    else:
        if args.reanalyze_local:
            in_tracks = base_payload.get("tracks", [])
            if not in_tracks:
                raise SystemExit(f"No tracks found in {args.data_js}")
        elif args.manifest and args.manifest.exists():
            in_tracks = json.loads(args.manifest.read_text(encoding="utf-8")).get("tracks", [])
        else:
            ap.error("Specify --reanalyze-local, --manifest, or --from-cache")

        analyzed = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = [pool.submit(reanalyze_track_worker, ffmpeg_bin, ROOT, t) for t in in_tracks]
            for fut in as_completed(futs):
                analyzed.append(fut.result())

    era_rank = {e: idx for idx, e in enumerate(ERA_ORDER)}
    analyzed.sort(key=lambda t: (era_rank.get(t["era"], 99), int(t.get("slot", 0)), t["id"]))
    if args.cache_json:
        args.cache_json.parent.mkdir(parents=True, exist_ok=True)
        args.cache_json.write_text(json.dumps(analyzed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    layout = cluster_and_layout(analyzed)
    by_id = {t["id"]: t for t in analyzed}

    meta = dict(base_payload.get("meta", {}))
    meta.update({
        "total_map_tracks": len(analyzed),
        "silhouette": layout["silhouette"],
        "style_groups": layout["style_groups"],
        "era_anchors": layout["era_anchors"],
        "track_near": layout["track_near"],
        "track_map": layout["track_map"],
    })

    eras = base_payload.get("eras", [])
    for er in eras:
        er_tracks = [t for t in analyzed if t["era"] == er["id"]]
        if er_tracks:
            er["tracks"] = er_tracks
            er["audio_files"] = max(int(er.get("audio_files") or 0), len(er_tracks))
    phases = base_payload.get("phases", [])
    for ph in phases:
        ph_tracks = [by_id[t["id"]] for t in ph.get("tracks", []) if t["id"] in by_id]
        if ph_tracks:
            ph["tracks"] = ph_tracks

    out_payload = {"meta": meta, "tracks": analyzed, "phases": phases, "eras": eras}
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(out_payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Analyzed {len(analyzed)} tracks -> {args.out_json} (silhouette={layout['silhouette']})")
    for g in layout["style_groups"]:
        names = [by_id[m]["title"] for m in g["members"]]
        print(f"  [{g['id']}] {g['label']} ({len(names)}): {', '.join(names[:6])}{' ...' if len(names) > 6 else ''}")


if __name__ == "__main__":
    main()

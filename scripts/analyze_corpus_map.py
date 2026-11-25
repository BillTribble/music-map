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
    "psychedailies": 2021, "archive_2018_23": 2021, "spirit_guides": 2025, "lucid_crystal": 2022,
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
        "raw_drum_complexity": round(raw_dc, 1),
        "raw_four_on_floor": round(raw_f4, 1),
        "raw_breakbeat_score": round(raw_brk, 1),
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


STAGING_DIR = Path.home() / "tmp" / "music_map_staging"

DEFAULT_EXCLUDED_IDS = {
    "archive_2013_18_44",
    "archive_2018_23_33",
    "archive_2018_23_64",
    "archive_2018_23_65",
    "present_electro_57",
    "present_electro_44",
    "present_electro_33",
    "hd_2005_35",
    "archive_2013_18_151",
    "sketches_2024_25_10",
    "archive_2013_18_24",
    "archive_2013_18_25",
    "archive_2013_18_48",
    "archive_2013_18_99",
    "archive_2013_18_109",
    "archive_2013_18_110",
    "archive_2013_18_111",
    "archive_2013_18_124",
    "archive_2013_18_92",
    "archive_2013_18_100",
    "archive_2013_18_113",
    "archive_2013_18_115",
    "archive_2013_18_144",
    "ecstatic_wave_7",
    "ecstatic_wave_8",
    "archive_2013_18_104",
    "archive_2013_18_118",
    "archive_2018_23_4",
    "archive_2018_23_5",
    "archive_2018_23_21",
    "archive_2018_23_27",
    "archive_2018_23_49",
    "archive_2018_23_50",
    "sketches_2024_25_20",
    "remixes_commissions_4",
    "remixes_commissions_5",
    "remixes_commissions_7",
    "remixes_commissions_11",
    "remixes_commissions_19",
    "archive_2018_23_34",
    "archive_2018_23_35",
    "archive_2018_23_40",
    "archive_2018_23_52",
    "archive_2018_23_55",
    "archive_2018_23_59",
    "archive_2018_23_60",
    "archive_2018_23_67",
    "archive_2018_23_6",
    "archive_2018_23_7",
    "archive_2018_23_8",
    "archive_2018_23_9",
    "archive_2018_23_10",
    "archive_2018_23_12",
    "archive_2018_23_13",
    "archive_2018_23_14",
    "archive_2018_23_15",
    "archive_2018_23_16",
    "archive_2018_23_17",
    "archive_2018_23_18",
    "archive_2018_23_20",
    "archive_2018_23_22",
    "archive_2018_23_23",
    "archive_2018_23_24",
    "archive_2018_23_25",
    "archive_2018_23_28",
    "archive_2018_23_29",
    "archive_2018_23_30",
    "archive_2018_23_31",
    "present_electro_45",
    "archive_2013_18_108",
    "archive_2013_18_119",
    "archive_2013_18_121",
    "archive_2013_18_129",
    "archive_2013_18_150",
    "archive_2013_18_23",
    "archive_2013_18_27",
    "archive_2013_18_39",
    "archive_2013_18_40",
    "archive_2013_18_41",
    "archive_2013_18_42",
    "archive_2013_18_58",
    "archive_2013_18_64",
    "archive_2013_18_7",
    "archive_2013_18_80",
    "archive_2013_18_88",
    "archive_2018_23_36",
    "archive_2018_23_37",
    "archive_2018_23_51",
    "archive_2018_23_54",
    "bands_archive_12",
    "bands_archive_13",
    "bands_archive_14",
    "bands_archive_16",
    "bands_archive_19",
    "bands_archive_7",
    "hd_2005_11",
    "hd_2005_12",
    "hd_2005_13",
    "hd_2005_17",
    "hd_2005_19",
    "hd_2005_21",
    "hd_2005_25",
    "hd_2005_26",
    "hd_2005_27",
    "hd_2005_30",
    "hd_2005_32",
    "hd_2005_36",
    "hd_2005_37",
    "hd_2005_38",
    "hd_2005_40",
    "hd_2005_41",
    "hd_2005_43",
    "hd_2005_44",
    "hd_2005_45",
    "hd_2005_9",
    "sketches_2024_25_25",
    "present_electro_5",
    "present_electro_50",
    "present_electro_52",
    "hd_2005_1",
    "hd_2005_24",
    "remixes_commissions_20",
    "present_electro_58",
    "psychedailies_12",
    "ep_concepts_27",
    "ep_concepts_29",
    "ecstatic_wave_12",
    "ep_concepts_19",
    "archive_2013_18_26",
    "bands_archive_11",
    "archive_2018_23_43",
    # AI Music Sandbox tests — excluded by owner (post-022956)
    "ai_music_040_c5fc24",
    "ai_music_041_528d02",
    "ai_music_042_76bf86",
    "ai_music_043_c65702",
    "ai_music_044_59712b",
    "ai_music_045_e6724a",
    "ai_music_046_98a2b8",
    "ai_music_047_a5f4b0",
    "ai_music_048_f6c999",
    "ai_music_049_d48364",
    "ai_music_050_9ad44e",
    "ai_music_051_405598",
    "ai_music_052_fdbda2",
    "ai_music_053_f76764",
    "ai_music_054_979585",
    "ai_music_055_1da212",
    "ai_music_056_39d1b9",
    "ai_music_057_e6639c",
    "ai_music_058_0b7730",
    "ai_music_059_e206b2",
    "ai_music_060_efa3b3",
    "ai_music_061_c77efc",
    "ai_music_062_d207d6",
    "ai_music_063_cfb329",
    "ai_music_064_1c73ac",
    "ai_music_065_b79945",
    "ai_music_066_84ef36",
    "ai_music_067_30817a",
    "ai_music_068_69176c",
    # Bill in China 1983 + latest-master-only dedup (post-023039, post-023042)
    "bands_archive_17",
    "sketches_2026_8", "sketches_2026_20", "sketches_2026_14", "sketches_2026_15",
    "ecstatic_wave_17", "sketches_2024_25_1",
    "ep_concepts_9", "ep_concepts_11", "ep_concepts_12", "ep_concepts_13",
    "ep_concepts_18", "ep_concepts_21", "ep_concepts_23", "ep_concepts_25", "ep_concepts_30",
    "archive_2013_18_105",
    "present_electro_59", "present_electro_1", "present_electro_47", "present_electro_35",
    "present_electro_51", "present_electro_53", "present_electro_62", "hd_2005_6", "psychedailies_6",
    "archive_2013_18_5", "archive_2013_18_60", "archive_2013_18_84", "archive_2018_23_53",
    "archive_2013_18_93", "archive_2013_18_94", "archive_2018_23_63",
    # MusicFX AI test — excluded by owner (post-023266)
    "archive_2018_23_45",
    "archive_2018_23_46",
}

CANONICAL_ARCHETYPES: list[tuple[str, str, int]] = [
    ("ambient", "Ambient & meditative", 205),
    ("dark_ambient", "Dark ambient & drone", 245),
    ("downtempo_lush", "Downtempo & lush chords", 165),
    ("chill_elec", "Chill & steady electronic", 130),
    ("guitar_demos", "Guitar demos", 38),
    ("hypnotic_micro", "Hypnotic electro & microtonal", 275),
    ("house_ecstatic", "House & ecstatic 4/4 groove", 24),
    ("dnb_breaks", "Complex drums & breaks", 345),
    ("ambient_rock", "Ambient rock", 84),
    ("rock", "Rock & guitar pop", 322),
]
ARCH_KEYS = [a[0] for a in CANONICAL_ARCHETYPES]
ARCH_LABELS = {a[0]: a[1] for a in CANONICAL_ARCHETYPES}
ARCH_HUES = {a[0]: a[2] for a in CANONICAL_ARCHETYPES}
ARCH_CANONICAL_IDX = {a[0]: idx for idx, a in enumerate(CANONICAL_ARCHETYPES)}

PIANO_SYNTH_RE = re.compile(
    r"\b(piano|kalimba|sid|c64|8bit|chiptune|arp|arps|imposcar|diva|serum|modsynth|"
    r"gamelan|choir|orchestral|techno|house|afro|jungle|d&b|808|ambi|ambisktch|rave|glitchbeat|wizball)\b",
    re.IGNORECASE,
)
GUITAR_INST_RE = re.compile(
    r"\b(guitar|jamstik|acoustic|strum|campfire|ukulele|3chord)\b",
    re.IGNORECASE,
)

ML_SYNONYM_RULES: list[tuple[tuple[str, ...], str]] = [
    (("ambient rock", "ambient_rock", "post-rock", "post rock", "shoegaze", "dream pop", "krautrock", "space rock", "slowcore", "math rock"), "ambient_rock"),
    (("guitar demo", "guitar_demos", "guitar sketch", "acoustic guitar", "singer-songwriter", "fingerstyle", "unplugged", "folk guitar", "acoustic"), "guitar_demos"),
    (("dark ambient", "dark_ambient", "drone", "doom", "industrial ambient", "darkwave", "soundscape"), "dark_ambient"),
    (("indie rock", "guitar pop", "indie pop", "post-punk", "punk", "garage rock", "grunge", "noise rock", "alternative rock", "hard rock", "art rock", "britpop", "power pop", "metal", "rock"), "rock"),
    (("drum and bass", "drum & bass", "drum n bass", "dnb", "d&b", "jungle", "breakbeat", "breaks", "footwork", "juke", "dubstep", "halftime", "drill", "grime", "broken beat", "big beat", "uk bass"), "dnb_breaks"),
    (("deep house", "tech house", "afro house", "afrohouse", "progressive house", "nu-disco", "disco", "melodic techno", "techno", "trance", "house", "ecstatic", "club", "dance", "four on the floor"), "house_ecstatic"),
    (("microtonal", "gamelan", "hypnotic", "acid", "braindance", "glitch", "berlin school", "modular", "minimal"), "hypnotic_micro"),
    (("downtempo", "trip hop", "trip-hop", "balearic", "chillwave", "neo-soul", "nu jazz", "future garage", "lush"), "downtempo_lush"),
    (("chillout", "chill_elec", "chill", "lo-fi", "lofi", "idm", "leftfield", "electronica", "synth-pop", "synthpop", "dub", "electro"), "chill_elec"),
    (("ambient", "meditative", "new age", "modern classical", "soundtrack", "atmospheric", "choral"), "ambient"),
]


def _norm_lookup_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def map_ml_label_to_archetype(raw_label: str) -> str | None:
    low = raw_label.lower().replace("---", " ").replace("_", " ").strip()
    if low in ARCH_CANONICAL_IDX:
        return low
    for keywords, arch in ML_SYNONYM_RULES:
        if any(kw in low for kw in keywords):
            return arch
    return None


def load_ml_genre_predictions(ml_path: Path | None) -> dict[str, dict[str, float]]:
    """Load optional external ML genre classifier predictions (e.g. JetSki CLAP/Essentia/AST/Gemini JSON)."""
    if not ml_path or not ml_path.exists():
        return {}
    raw = json.loads(ml_path.read_text(encoding="utf-8"))
    entries: list[tuple[str, object]] = []
    if isinstance(raw, dict):
        container = raw.get("tracks") or raw.get("predictions") or raw.get("results") or raw
        if isinstance(container, dict):
            entries = list(container.items())
        elif isinstance(container, list):
            for item in container:
                if isinstance(item, dict):
                    k = str(item.get("id") or item.get("track_id") or item.get("local_path") or item.get("path") or item.get("title") or "")
                    if k:
                        entries.append((k, item))
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                k = str(item.get("id") or item.get("track_id") or item.get("local_path") or item.get("path") or item.get("title") or "")
                if k:
                    entries.append((k, item))

    parsed_index: dict[str, dict[str, float]] = {}
    for key, val in entries:
        arch_scores = {a: 0.0 for a in ARCH_KEYS}
        if isinstance(val, str):
            mapped = map_ml_label_to_archetype(val)
            if mapped:
                arch_scores[mapped] = 85.0
        elif isinstance(val, dict):
            score_map = val.get("scores") or val.get("probs") or val.get("probabilities") or val.get("genres")
            if isinstance(score_map, dict):
                vals = [float(v) for v in score_map.values() if isinstance(v, (int, float))]
                scale = 100.0 if (vals and max(vals) <= 1.05) else 1.0
                for lbl, sc in score_map.items():
                    if isinstance(sc, (int, float)):
                        mapped = map_ml_label_to_archetype(str(lbl))
                        if mapped:
                            arch_scores[mapped] = max(arch_scores[mapped], clamp(float(sc) * scale))
            top_list = val.get("top_genres") or val.get("labels") or val.get("predictions")
            if isinstance(top_list, list):
                for item in top_list:
                    if isinstance(item, (list, tuple)) and len(item) >= 2:
                        lbl, sc = str(item[0]), float(item[1])
                        scale = 100.0 if sc <= 1.05 else 1.0
                        mapped = map_ml_label_to_archetype(lbl)
                        if mapped:
                            arch_scores[mapped] = max(arch_scores[mapped], clamp(sc * scale))
                    elif isinstance(item, dict):
                        lbl = str(item.get("label") or item.get("genre") or "")
                        sc = float(item.get("score") or item.get("confidence") or item.get("prob") or 0.8)
                        scale = 100.0 if sc <= 1.05 else 1.0
                        mapped = map_ml_label_to_archetype(lbl)
                        if mapped:
                            arch_scores[mapped] = max(arch_scores[mapped], clamp(sc * scale))
            single_lbl = val.get("label") or val.get("genre") or val.get("cluster") or val.get("predicted_genre")
            if isinstance(single_lbl, str):
                conf = float(val.get("confidence") or val.get("score") or val.get("prob") or 0.85)
                scale = 100.0 if conf <= 1.05 else 1.0
                mapped = map_ml_label_to_archetype(single_lbl)
                if mapped:
                    arch_scores[mapped] = max(arch_scores[mapped], clamp(conf * scale))
            if max(arch_scores.values()) == 0.0:
                vals = [float(v) for k_v, v in val.items() if k_v in ARCH_CANONICAL_IDX and isinstance(v, (int, float))]
                scale = 100.0 if (vals and max(vals) <= 1.05) else 1.0
                for k_v, v in val.items():
                    if k_v in ARCH_CANONICAL_IDX and isinstance(v, (int, float)):
                        arch_scores[k_v] = clamp(float(v) * scale)

        if max(arch_scores.values()) > 0.0:
            parsed_index[key] = arch_scores
            parsed_index[_norm_lookup_key(key)] = arch_scores
            parsed_index[_norm_lookup_key(Path(key).name)] = arch_scores
            parsed_index[_norm_lookup_key(Path(key).stem)] = arch_scores
    return parsed_index


def lookup_ml_scores(t: dict, ml_index: dict[str, dict[str, float]]) -> dict[str, float] | None:
    if not ml_index:
        return None
    lp = str(t.get("local_path") or "")
    candidates = [
        str(t.get("id") or ""),
        lp,
        Path(lp).name if lp else "",
        Path(lp).stem if lp else "",
        str(t.get("slug") or ""),
        str(t.get("title") or ""),
    ]
    for c in candidates:
        if not c:
            continue
        if c in ml_index:
            return ml_index[c]
        nk = _norm_lookup_key(c)
        if nk and nk in ml_index:
            return ml_index[nk]
    return None


def compute_folder_genre_priors(t: dict) -> tuple[dict[str, float], dict[str, object]]:
    """Extract clean folder-hierarchy & instrument priors from local_path + metadata."""
    lp = str(t.get("local_path") or "").lower()
    title = str(t.get("title") or "").lower()
    p = {a: 0.0 for a in ARCH_KEYS}
    rule: str | None = None

    is_elec_folder = any(
        k in lp
        for k in (
            "06 - ecstatic wave", "flow wave continue", "01 - nihon forever",
            "02 - le garage herm", "le garage era tracks", "03 - spirit guides",
            "04 - lucid crystal", "ai music 2025", "present trax", "02 - psychedailies",
            "offal beats", "^ music sketches 2026", "ai afrohouse", "afro retro", "techno idea",
            "musicfx ai test", "maschine", "05 - reflective disc",
        )
    )
    is_band_folder = any(
        k in lp
        for k in (
            "/my own band/", "/psykers/", "/yon/", "/spudboy/", "/random bill bands/",
            "cae - idles cover", "06 skullz - endlesss band", "/^ jams/",
        )
    ) or ("spudboy -" in title or "spudboy —" in title or "slint" in title)
    is_piano_or_chip = bool(PIANO_SYNTH_RE.search(title) or PIANO_SYNTH_RE.search(lp))

    perc_share = float(t.get("perc_share", 0.0))
    energy = float(t.get("energy", 5))
    mid_share = float(t.get("mid_share", 0.0))
    sub_share = float(t.get("sub_share", 0.0))
    cr = float(t.get("chord_richness", 50.0))

    if "dark ambient ep" in lp:
        p["dark_ambient"], p["ambient"], rule = 92.0, 35.0, "folder:dark_ambient_ep"
    elif "03 - spirit guides" in lp or "jungle and rain atmos" in lp:
        p["ambient"], p["dark_ambient"], rule = 88.0, 48.0, "folder:spirit_guides_ambient"
    elif "/present trax/ambient/" in lp:
        if perc_share >= 0.16 and energy >= 4:
            p["chill_elec"], p["downtempo_lush"], p["ambient"], rule = 78.0, 62.0, 35.0, "folder:present_ambient_beat"
        else:
            p["ambient"], p["dark_ambient"], rule = 88.0, 48.0, "folder:present_ambient"
    elif "04 - lucid crystal" in lp:
        p["ambient"], p["downtempo_lush"], rule = 72.0, 58.0, "folder:lucid_crystal"
    elif "chill choir" in lp or "orchestral abstract" in lp or "vocal orchestral" in lp or re.search(r"\borch\b", title):
        p["downtempo_lush"], p["ambient"], rule = 62.0, 80.0, "folder:orchestral_chill"
    elif "guitar sketches" in lp or "guitar loop for kinbana" in lp or "simple mics setup" in lp:
        p["guitar_demos"], rule = 95.0, "folder:guitar_demos"
    elif "jamstik" in lp or "jamstik" in title:
        if "ambient" in title or "crystal bell" in title or perc_share < 0.05:
            p["ambient"], rule = 88.0, "title:jamstik_ambient"
        else:
            p["guitar_demos"], rule = 95.0, "title:jamstik_guitar"
    elif any(k in lp for k in ("/my own band/", "/psykers/", "/yon/", "cae - idles cover", "06 skullz - endlesss band")):
        p["rock"], p["ambient_rock"], rule = 90.0, 38.0, "folder:band_rock"
    elif "/random bill bands/" in lp:
        if mid_share >= 0.15:
            if perc_share < 0.15 and energy <= 6:
                p["ambient_rock"], p["rock"], rule = 85.0, 55.0, "folder:bill_bands_amb_rock"
            else:
                p["rock"], p["ambient_rock"], rule = 90.0, 40.0, "folder:bill_bands_rock"
    elif "/spudboy/" in lp or "spudboy -" in title or "spudboy —" in title:
        if perc_share < 0.04 and energy <= 3:
            p["dark_ambient"], rule = 88.0, "folder:spudboy_drone"
        elif perc_share < 0.10:
            p["ambient_rock"], p["rock"], rule = 88.0, 45.0, "folder:spudboy_amb_rock"
        else:
            p["rock"], p["ambient_rock"], rule = 86.0, 35.0, "folder:spudboy_rock"
    elif "(spudboy" in title:
        p["rock"], p["house_ecstatic"], p["dnb_breaks"], rule = 58.0, 48.0, 45.0, "title:spudboy_remix"
    elif "/^ jams/" in lp:
        if "3chord" in title:
            p["guitar_demos"], p["rock"], rule = 84.0, 52.0, "folder:jams_guitar"
        else:
            p["rock"], p["ambient_rock"], rule = 84.0, 38.0, "folder:jams_band"
    elif "slint" in title or "slinted" in title:
        if energy <= 6 and cr >= 75:
            p["ambient_rock"], p["rock"], rule = 86.0, 62.0, "title:slint_post_rock"
        else:
            p["rock"], p["ambient_rock"], rule = 90.0, 50.0, "title:slint_rock"
    elif title.strip() == "rock sketch":
        p["rock"], rule = 92.0, "title:rock_sketch"
    elif "deepspace guitar" in title:
        p["ambient"], p["ambient_rock"], rule = 76.0, 58.0, "title:deepspace_guitar"
    elif GUITAR_INST_RE.search(title) and not is_elec_folder:
        p["guitar_demos"], p["rock"], rule = 88.0, 32.0, "title:guitar_inst"
    elif "rc505 looper sketches" in lp:
        if sub_share < 0.15:
            p["guitar_demos"], rule = 85.0, "folder:rc505_guitar"
        else:
            p["chill_elec"], p["downtempo_lush"], rule = 72.0, 48.0, "folder:rc505_bass_looper"
    elif any(k in lp for k in ("d&b qzb", "sax d&b", "vox d&b", "breakbeat loops", "classic breaks", "fong drill", "vivaldi drill", "kaskrilli")):
        p["dnb_breaks"], rule = 92.0, "folder:dnb_breaks"
    elif "offal beats" in lp:
        p["dnb_breaks"], p["hypnotic_micro"], rule = 72.0, 58.0, "folder:offal_beats"
    elif "02 - le garage herm" in lp or "le garage era tracks" in lp or "gamelan" in lp:
        p["hypnotic_micro"], p["downtempo_lush"], rule = 86.0, 38.0, "folder:le_garage_micro"
    elif "01 - nihon forever" in lp:
        p["hypnotic_micro"], p["downtempo_lush"], p["house_ecstatic"], rule = 60.0, 48.0, 44.0, "folder:nihon_forever"
    elif any(k in lp for k in ("06 - ecstatic wave", "flow wave continue", "ai afrohouse", "afro retro", "techno idea")):
        p["house_ecstatic"], p["downtempo_lush"], rule = 85.0, 35.0, "folder:ecstatic_house"
    elif any(k in lp for k in ("/^ downtempo/", "summon downtempo", "dom piano ravel", "me and mya piano", "kalimba, piano")):
        p["downtempo_lush"], p["chill_elec"], rule = 82.0, 50.0, "folder:downtempo"
    elif "/present trax/mid tempo/" in lp:
        p["chill_elec"], p["downtempo_lush"], p["dnb_breaks"], rule = 72.0, 45.0, 40.0, "folder:present_midtempo"
    elif "/^ uptempo" in lp or "/present trax/up tempo/" in lp:
        p["house_ecstatic"], p["dnb_breaks"], p["hypnotic_micro"], rule = 66.0, 62.0, 48.0, "folder:uptempo"

    flags = {
        "rule": rule,
        "is_elec_folder": is_elec_folder,
        "is_band_folder": is_band_folder,
        "is_piano_or_chip": is_piano_or_chip,
    }
    return p, flags


def recalibrate_and_score_track(
    t: dict,
    ml_index: dict[str, dict[str, float]] | None = None,
    w_folder: float = 0.52,
    w_dsp: float = 0.48,
    w_ml: float = 0.32,
) -> str:
    """Recalibrate DSP drum/BPM gates and score track across 10 archetypes (folder + DSP + optional ML)."""
    tc = float(t.get("transient_conf", 0.5))
    old_gv = float(t.get("guitar_vocal_score", 0.0))
    perc_share = float(t.get("perc_share", 0.05))
    perc_rate = float(t.get("perc_onset_rate", 1.5))
    en = float(t.get("energy", 5))
    mid = float(t.get("mid_share", 0.2))
    sub = float(t.get("sub_share", 0.2))
    bass = float(t.get("bass_share", 0.25))
    high = float(t.get("high_share", 0.04))
    hc = float(t.get("harmonic_complexity", 50.0))
    cr = float(t.get("chord_richness", 50.0))
    md = float(t.get("modal_darkness", 50.0))
    micro = float(t.get("microtonal_score", 0.0))
    bpm = float(t.get("bpm", 110.0))
    era = str(t.get("era", ""))

    # 1. Recover ungated drum & groove metrics (or read raw_* directly when freshly decoded)
    if "raw_drum_complexity" in t:
        raw_dc = float(t["raw_drum_complexity"])
        raw_f4 = float(t.get("raw_four_on_floor", t.get("four_on_floor", 0.0)))
        raw_brk = float(t.get("raw_breakbeat_score", t.get("breakbeat_score", 0.0)))
    else:
        if tc > 0.005:
            raw_f4 = clamp(float(t.get("four_on_floor", 0.0)) / (tc ** 1.4))
            raw_brk = clamp(float(t.get("breakbeat_score", 0.0)) / ((tc ** 1.4) * max(0.15, 1.0 - 0.65 * (old_gv / 100.0))))
        else:
            raw_f4, raw_brk = 0.0, 0.0
        raw_dc = compute_drum_complexity(
            perc_share, perc_rate, float(t.get("gap_cv", 0.2)), float(t.get("gap_entropy", 0.1)), float(t.get("high_low_ratio", 0.3)), raw_brk
        )

    f_priors, flags = compute_folder_genre_priors(t)
    rule = flags["rule"]
    is_elec_folder = bool(flags["is_elec_folder"])
    is_band_folder = bool(flags["is_band_folder"])
    is_piano_or_chip = bool(flags["is_piano_or_chip"])
    is_explicit_ambient = rule in (
        "folder:spirit_guides_ambient", "folder:present_ambient", "folder:dark_ambient_ep",
        "title:jamstik_ambient", "folder:spudboy_drone", "title:deepspace_guitar", "folder:orchestral_chill",
    )

    # 2. Un-crush compressed wall-of-sound tracks (e.g. Your a Genius, demo G 02, Make It Thru)
    wall_perc = (
        clamp((perc_share - 0.10) / 0.11, 0.0, 1.0)
        * clamp((perc_rate - 1.6) / 1.5, 0.0, 1.0)
        * clamp((en - 3.2) / 3.0, 0.0, 1.0)
    )
    eff_tc = tc if is_explicit_ambient else max(tc, (0.44 + 0.52 * wall_perc) if wall_perc > 0.05 else tc)
    if eff_tc < 0.55:
        dc = round(raw_dc * (0.08 + 0.92 * (eff_tc ** 1.1)), 1)
    else:
        dc = round(raw_dc, 1)
    f4 = round(raw_f4 * (eff_tc ** 1.2), 1)
    brk = round(raw_brk * (eff_tc ** 1.2), 1)

    # 3. Double-time BPM octave fix on strummed guitar / non-sub midrange tracks (e.g. 172.27 -> 86.14 BPM)
    mus_bpm = bpm
    if bpm >= 148.0 and ((sub < 0.12 and mid >= 0.23) or (bpm >= 183.0 and sub < 0.30)):
        mus_bpm = round(bpm * 0.5, 2)

    # 4. Recompute Dark Ambient score with un-crushed drum_complexity
    low_end_w = clamp((sub + bass - 0.50) / 0.22, 0.0, 1.0)
    drum_pres = clamp(dc / 28.0, 0.0, 1.0)
    hi_norm = clamp(high / 0.04, 0.0, 1.0)
    da = round(clamp(100.0 * (1.0 - drum_pres) * (0.58 * low_end_w + 0.22 * (md / 100.0) + 0.20 * (1.0 - hi_norm))), 1)

    # 5. Guitar Demos DSP detector (E2=82.4 Hz => sub_share ~ 0, strong mid+bass guitar body, strummed perc)
    gd_gate = (
        clamp((0.025 - sub) / 0.020, 0.0, 1.0)
        * clamp((mid - 0.17) / 0.08, 0.0, 1.0)
        * clamp((mid + bass - 0.74) / 0.14, 0.0, 1.0)
        * clamp((perc_share - 0.045) / 0.05, 0.0, 1.0)
        * clamp((0.43 - perc_share) / 0.09, 0.0, 1.0)
    )
    if is_elec_folder or is_piano_or_chip:
        gd_gate *= 0.05
    if is_band_folder and rule != "folder:jams_guitar":
        gd_gate *= 0.15
    if en >= 9 and perc_share >= 0.27 and high >= 0.06:
        gd_gate *= 0.25
    gd_dsp = round(clamp(gd_gate * (74.0 + 16.0 * clamp((mid + bass - 0.80) / 0.15, 0.0, 1.0) + 10.0 * clamp(hc / 80.0, 0.0, 1.0))), 1)

    # 6. Rock & Guitar Pop DSP detector (midrange harmonic grit + live cymbals/snare + E>=6, NO 4/4 penalty!)
    rock_gate = (
        clamp((mid - 0.22) / 0.09, 0.0, 1.0)
        * clamp((high - 0.032) / 0.055, 0.0, 1.0)
        * clamp((dc - 46.0) / 16.0, 0.0, 1.0)
        * clamp((perc_share - 0.16) / 0.10, 0.0, 1.0)
        * clamp((en - 5.5) / 2.5, 0.0, 1.0)
        * clamp((0.55 - sub) / 0.16, 0.0, 1.0)
        * clamp((sub - 0.022) / 0.035, 0.20, 1.0)
    )
    if is_elec_folder or is_piano_or_chip:
        rock_gate *= 0.12
    rock_dsp = round(clamp(rock_gate * (72.0 + 16.0 * clamp((mid - 0.25) / 0.22, 0.0, 1.0) + 12.0 * clamp((high - 0.04) / 0.10, 0.0, 1.0))), 1)

    # 7. Ambient Rock DSP detector (shoegaze/post-rock drum wash OR lush harmonic guitar/vocal + live drums)
    wash_lush = (
        clamp((0.62 - tc) / 0.34, 0.0, 1.0)
        * clamp((hc - 56.0) / 18.0, 0.0, 1.0)
        * clamp((cr - 56.0) / 24.0, 0.0, 1.0)
        * clamp((mid - 0.18) / 0.09, 0.0, 1.0)
    )
    gv_atmos = (
        clamp((old_gv - 30.0) / 25.0, 0.0, 1.0)
        * clamp((0.27 - perc_share) / 0.09, 0.0, 1.0)
        * clamp((9.0 - en) / 2.5, 0.35, 1.0)
    )
    ar_core = max(wash_lush, 0.92 * gv_atmos)
    ar_gate = (
        ar_core
        * clamp((perc_share - 0.095) / 0.055, 0.0, 1.0)
        * clamp((0.35 - perc_share) / 0.10, 0.25, 1.0)
        * clamp((en - 2.5) / 2.2, 0.0, 1.0)
        * clamp((0.48 - sub) / 0.18, 0.0, 1.0)
    )
    if is_elec_folder or is_piano_or_chip:
        ar_gate *= 0.15
    if high >= 0.11 and perc_share >= 0.28 and en >= 9:
        ar_gate *= 0.25
    ar_dsp = round(clamp(ar_gate * (76.0 + 14.0 * clamp((0.55 - tc) / 0.35, 0.0, 1.0) + 10.0 * clamp((cr - 65.0) / 25.0, 0.0, 1.0))), 1)

    micro_eff = micro if era in ("le_garage", "ep_concepts", "nihon_forever", "sketches_2024_25", "remixes_commissions", "lucid_crystal") else micro * 0.25
    guitar_or_rock_suppress = 1.0 - 0.50 * clamp(max(rock_dsp, gd_dsp, ar_dsp) / 68.0, 0.0, 1.0)

    dsp_scores = {
        "ambient": round(clamp(((82.0 if dc < 22 and da < 38 else 10.0) + (10.0 - en) * 2.2 - da * 0.5 - dc * 0.9) * (1.0 - 0.7 * clamp(gd_dsp / 60.0, 0.0, 1.0))), 1),
        "dark_ambient": round(clamp((85.0 if dc < 22 and da >= 36 else 8.0) + da * 0.65 - dc * 0.9), 1),
        "downtempo_lush": round(clamp(((56.0 if 18 <= dc < 58 and f4 < 48 and brk < 36 and mus_bpm < 116 else 16.0) + cr * 0.25 + hc * 0.12 - en * 1.6 - brk * 0.25) * guitar_or_rock_suppress), 1),
        "chill_elec": round(clamp(((60.0 if dc >= 22 and mus_bpm < 106 and f4 < 54 and brk < 40 else 16.0) + (108.0 - mus_bpm) * 0.32 - f4 * 0.20 - brk * 0.20) * guitar_or_rock_suppress), 1),
        "guitar_demos": gd_dsp,
        "hypnotic_micro": round(clamp(((54.0 if 94 <= mus_bpm < 146 and dc >= 40 and brk < 48 and f4 < 58 else 14.0) + micro_eff * 0.48 + dc * 0.20 - brk * 0.15) * guitar_or_rock_suppress), 1),
        "house_ecstatic": round(clamp(((64.0 if f4 >= 50 and dc >= 38 else 12.0) + f4 * 0.32 + en * 1.0 - brk * 0.30) * guitar_or_rock_suppress), 1),
        "dnb_breaks": round(clamp(((66.0 if brk >= 42 and f4 < 50 and sub >= 0.06 else 12.0) + brk * 0.42 + dc * 0.22 + clamp((bpm - 125.0) * 0.22, 0.0, 14.0) - f4 * 0.30) * (0.20 if sub < 0.03 and mid > 0.23 else guitar_or_rock_suppress)), 1),
        "ambient_rock": ar_dsp,
        "rock": rock_dsp,
    }

    ml_scores = lookup_ml_scores(t, ml_index or {})
    has_prior = max(f_priors.values()) > 0.0
    has_ml = ml_scores is not None and max(ml_scores.values()) > 0.0

    if has_prior and has_ml and ml_scores is not None:
        tot = max(1e-6, w_folder + w_dsp + w_ml)
        wf, wd, wm = w_folder / tot, w_dsp / tot, w_ml / tot
        comb = {a: round(wf * f_priors[a] + wd * dsp_scores[a] + wm * ml_scores[a], 1) for a in ARCH_KEYS}
    elif has_prior:
        tot = max(1e-6, w_folder + w_dsp)
        wf, wd = w_folder / tot, w_dsp / tot
        comb = {a: round(wf * f_priors[a] + wd * dsp_scores[a], 1) for a in ARCH_KEYS}
    elif has_ml and ml_scores is not None:
        tot = max(1e-6, w_dsp + w_ml)
        wd, wm = w_dsp / tot, w_ml / tot
        comb = {a: round(wd * dsp_scores[a] + wm * ml_scores[a], 1) for a in ARCH_KEYS}
    else:
        comb = dict(dsp_scores)

    best_arch = max(ARCH_KEYS, key=lambda a: comb[a])

    # Write recalibrated metrics onto track dict
    t["drum_complexity"] = dc
    t["four_on_floor"] = f4
    t["breakbeat_score"] = brk
    t["dark_ambient_score"] = da
    t["musical_bpm"] = mus_bpm
    t["rock_score"] = rock_dsp
    t["ambient_rock_score"] = ar_dsp
    t["guitar_demo_score"] = gd_dsp
    t["guitar_vocal_score"] = round(max(gd_dsp, 0.65 * rock_dsp, 0.55 * ar_dsp), 1)
    if rule:
        t["folder_prior"] = rule
    t["genre_scores"] = comb

    if best_arch == "rock":
        t["groove_style"] = "rock"
    elif best_arch == "ambient_rock":
        t["groove_style"] = "ambient_rock"
    elif best_arch == "guitar_demos":
        t["groove_style"] = "guitar_demo"
    elif best_arch == "dark_ambient":
        t["groove_style"] = "dark_ambient"
    elif best_arch == "ambient":
        t["groove_style"] = "ambient"
    elif f4 >= brk + 6.0 and f4 >= 36.0:
        t["groove_style"] = "four_on_floor"
    elif brk >= f4 + 4.0 and brk >= 34.0:
        t["groove_style"] = "breakbeat"
    else:
        t["groove_style"] = "downtempo"

    return best_arch


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

    dc, en, bpm = t["drum_complexity"], t["energy"], float(t.get("musical_bpm", t["bpm"]))
    f4, brk = float(t.get("four_on_floor", 0.0)), float(t.get("breakbeat_score", 0.0))
    cid = str(t.get("cluster_id", ""))
    if cid.endswith("_rock") and not cid.endswith("_ambient_rock"):
        r_tag = "Driving guitar & rock kit"
    elif cid.endswith("_ambient_rock"):
        r_tag = "Atmospheric drum & guitar wash"
    elif cid.endswith("_guitar_demos"):
        r_tag = "Acoustic / electric guitar demo"
    elif dc < 20 and t.get("dark_ambient_score", 0.0) >= 28.0:
        r_tag = "Dark ambient drone"
    elif dc < 24 and t["perc_share"] < 0.08:
        r_tag = "Beatless ambient wash"
    elif dc < 36:
        r_tag = "Spacious / minimal pulse"
    elif float(t["bpm"]) >= 158 and dc >= 48 and brk >= 35:
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
    base_bpm = float(t.get("musical_bpm", t["bpm"]))
    return round(r_conf * base_bpm + (1.0 - r_conf) * 68.0, 2)


def cluster_and_layout(tracks: list[dict]) -> dict:
    """Assign tracks into the canonical 10 Vibe groups, emit 8-dim feat_vec, and project Vibe + Era coords."""
    for t in tracks:
        t["effective_bpm"] = effective_tempo(t)
        pul_presence = clamp((float(t.get("perc_share", 0.0)) - 0.02) / 0.10, 0.0, 1.0) * max(0.35, float(t.get("transient_conf", 1.0)))
        t["drum_pulse"] = round(float(t.get("pulse_clarity", 0.0)) * pul_presence * 100.0, 1)

    # 8-dimensional standardized continuous sonic feature vector (for WT-4 full-catalog no-repeat similarity walk)
    sonic_w = np.array([1.55, 1.75, 1.45, 1.65, 1.65, 1.35, 1.25, 0.95], dtype=np.float64)
    X_sonic_raw = np.array([
        [
            float(t["energy"]),
            float(t["effective_bpm"]),
            float(t["drum_complexity"]),
            float(t.get("four_on_floor", 0.0)),
            float(t.get("breakbeat_score", 0.0)),
            float(t.get("mid_share", 0.2)),
            float(t.get("sub_share", 0.2)) + float(t.get("bass_share", 0.25)),
            float(t["harmonic_complexity"]),
        ]
        for t in tracks
    ], dtype=np.float64)
    X_sonic = StandardScaler().fit_transform(X_sonic_raw) * sonic_w
    for i, t in enumerate(tracks):
        t["feat_vec"] = [round(float(v), 3) for v in X_sonic[i]]

    # Ensemble 10-archetype score matrix
    S_ens = np.array(
        [[float(t.get("genre_scores", {}).get(aid, 0.0)) for aid in ARCH_KEYS] for t in tracks],
        dtype=np.float64,
    )
    win_arch_idxs = np.argmax(S_ens, axis=1)

    # Combine sonic coordinates + normalized ensemble territory pull for cohesive, high-legibility 2D Vibe islands
    X_map = np.hstack([X_sonic, (S_ens / 22.0) * 1.65])

    # Pairwise sonic distance for track_near (pure sonic distance + gentle same-cluster continuity bonus)
    D_sonic = np.linalg.norm(X_sonic[:, None, :] - X_sonic[None, :, :], axis=2)
    same_arch = (win_arch_idxs[:, None] == win_arch_idxs[None, :]).astype(np.float64)
    D_sim = D_sonic * (1.0 - 0.14 * same_arch)

    arch_members: dict[str, list[int]] = {aid: [] for aid in ARCH_KEYS}
    for i, a_idx in enumerate(win_arch_idxs):
        arch_members[ARCH_KEYS[int(a_idx)]].append(i)

    active_archs = [aid for aid in ARCH_KEYS if arch_members[aid]]
    merged_labels = np.array([int(win_arch_idxs[i]) for i in range(len(tracks))], dtype=int)
    sil = float(silhouette_score(X_map, merged_labels)) if len(set(merged_labels)) >= 2 and len(tracks) > len(set(merged_labels)) else 0.0

    perp = min(24, max(6, len(tracks) // 16)) if len(tracks) > 100 else min(14, max(5, max(2, len(tracks) // 5)))
    xy = TSNE(n_components=2, perplexity=perp, init="pca", learning_rate="auto", random_state=42).fit_transform(X_map)
    xy = (xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0) + 1e-9)

    # Pull Dark Ambient & Ambient Rock smoothly adjacent to Ambient & meditative
    amb_idxs = arch_members.get("ambient", [])
    da_idxs = arch_members.get("dark_ambient", [])
    ar_idxs = arch_members.get("ambient_rock", [])
    if amb_idxs and da_idxs:
        amb_cent = xy[amb_idxs].mean(axis=0)
        da_cent = xy[da_idxs].mean(axis=0)
        target_cent = np.clip(amb_cent + np.array([0.085, 0.055]), 0.10, 0.90)
        xy[da_idxs] = xy[da_idxs] - da_cent + target_cent
    if amb_idxs and ar_idxs:
        amb_cent = xy[amb_idxs].mean(axis=0)
        ar_cent = xy[ar_idxs].mean(axis=0)
        target_ar = np.clip(amb_cent + np.array([0.115, -0.065]), 0.10, 0.90)
        xy[ar_idxs] = 0.55 * xy[ar_idxs] + 0.45 * (xy[ar_idxs] - ar_cent + target_ar)

    for aid in active_archs:
        idxs = arch_members[aid]
        cent = xy[idxs].mean(axis=0)
        xy[idxs] = 0.76 * xy[idxs] + 0.24 * cent

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
    for aid in active_archs:
        c_idx = ARCH_CANONICAL_IDX[aid]
        alabel = ARCH_LABELS[aid]
        gid = f"s{c_idx}_{aid}"
        idxs = arch_members[aid]
        member_ids = [tracks[i]["id"] for i in idxs]
        for i in idxs:
            tracks[i]["cluster_id"] = gid
            tracks[i]["cluster_label"] = alabel
            tracks[i]["cluster_idx"] = c_idx
            h_tag, r_tag = make_tags(tracks[i])
            tracks[i]["harmony_tag"], tracks[i]["rhythm_tag"] = h_tag, r_tag

        cent = xy[idxs].mean(axis=0)
        min_x, max_x = float(np.min(xy[idxs, 0])), float(np.max(xy[idxs, 0]))
        min_y, max_y = float(np.min(xy[idxs, 1])), float(np.max(xy[idxs, 1]))
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
            "id": gid,
            "label": alabel,
            "idx": c_idx,
            "hue": ARCH_HUES[aid],
            "members": member_ids,
            "cx": round(min(0.87, max(0.13, bx)), 4),
            "cy": round(min(0.94, max(0.055, by)), 4),
        })

    scale = float(np.median(D_sim[D_sim > 0])) or 1.0
    track_near = {
        t["id"]: [[tracks[j]["id"], round(float(math.exp(-D_sim[i, j] / scale)), 3)] for j in np.argsort(D_sim[i]) if j != i][:4]
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
    is_forced_sketch = (
        tid in {"archive_2013_18_97"}
        or str(t.get("title") or "").strip().lower() in {"massive dune patch"}
    )
    is_sketch = False if t.get("is_ai") else bool(
        is_forced_sketch
        or (not released and full_dur is not None and float(full_dur) < 75.0)
    )
    tier = "released" if released else ("free_download" if t.get("is_ai") else ("archive_dl" if year < 2015 else "request"))
    t.update({"year": year, "released": released, "is_sketch": is_sketch, "tier": tier})
    if is_forced_sketch:
        t["wip_eligible"] = False
    if links:
        t["links"] = links
    else:
        t.pop("links", None)
    if tier in ("archive_dl", "free_download"):
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


def is_excluded_by_folder_rule(path_str: str) -> bool:
    if not path_str:
        return False
    low_p = path_str.lower()
    if "ai music sandbox" in low_p or "musicfx ai test" in low_p or "bill in china" in low_p:
        return True
    parts = [p.strip() for p in low_p.split("/") if p.strip()]
    for idx, p in enumerate(parts[:-1]):
        if p in ("^ exports - reflective album", "exports - reflective album", "exports-reflective album"):
            next_sub = parts[idx + 1] if idx + 1 < len(parts) - 1 else ""
            if next_sub not in ("^ uptempo level match", "uptempo level match"):
                return True
    return False


def load_excluded_ids(exclusions_path: Path | None) -> set[str]:
    out = set(DEFAULT_EXCLUDED_IDS)
    if exclusions_path and exclusions_path.exists():
        data = json.loads(exclusions_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "excluded_ids" in data:
            out.update(str(x) for x in data["excluded_ids"])
        elif isinstance(data, list):
            out.update(str(x) for x in data)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Analyze corpus audio and build 10-cluster Vibe + Era layout.")
    ap.add_argument("--reanalyze-local", action="store_true", help="Re-analyze local audio/*.mp3 merged with js/data.js")
    ap.add_argument("--data-js", type=Path, default=ROOT / "js" / "data.js")
    ap.add_argument("--manifest", type=Path, default=None, help="Optional catalog_manifest.json for full corpus analysis")
    ap.add_argument("--catalog-json", type=Path, default=STAGING_DIR / "catalog_587_enriched.json", help="Catalog JSON with local_path folder priors")
    ap.add_argument("--exclusions-json", type=Path, default=STAGING_DIR / "exclusions.json", help="JSON listing excluded track IDs")
    ap.add_argument("--keep-excluded", action="store_true", help="Do not drop excluded_ids before clustering")
    ap.add_argument("--ml-scores", type=Path, default=STAGING_DIR / "ml_genres.json", help="Optional ML genre predictions JSON")
    ap.add_argument("--no-ml-scores", action="store_true", help="Disable ML genre prediction blending even if ml_genres.json exists")
    ap.add_argument("--w-folder", type=float, default=0.52, help="Ensemble weight for folder-hierarchy priors")
    ap.add_argument("--w-dsp", type=float, default=0.48, help="Ensemble weight for recalibrated DSP detectors")
    ap.add_argument("--w-ml", type=float, default=0.32, help="Ensemble weight for optional ML genre predictions")
    ap.add_argument("--cache-json", type=Path, default=None, help="Optional path to cache raw DSP tracks before clustering")
    ap.add_argument("--from-cache", type=Path, default=None, help="Optional cached raw DSP JSON to skip audio decoding")
    ap.add_argument("--out-json", type=Path, default=STAGING_DIR / "analyzed_latest.json")
    ap.add_argument("--workers", type=int, default=min(16, os.cpu_count() or 4))
    args = ap.parse_args()

    base_payload: dict = {}
    if args.data_js.exists():
        raw = args.data_js.read_text(encoding="utf-8")
        if "window.CORPUS_DATA = " in raw:
            base_payload = json.loads(raw.split("window.CORPUS_DATA = ", 1)[1].rstrip().rstrip(";"))
    elif (STAGING_DIR / "analyzed_559.json").exists():
        base_payload = json.loads((STAGING_DIR / "analyzed_559.json").read_text(encoding="utf-8"))

    # Preserve preview clip timing/loudness/release metadata from baseline data.js / analyzed_559.json
    baseline_by_id: dict[str, dict] = {t["id"]: t for t in base_payload.get("tracks", [])}
    if (STAGING_DIR / "analyzed_559.json").exists():
        for t_prev in json.loads((STAGING_DIR / "analyzed_559.json").read_text(encoding="utf-8")).get("tracks", []):
            baseline_by_id.setdefault(t_prev["id"], t_prev)

    # Load local_path folder hierarchy from catalog_587_enriched.json
    cat_path_by_id: dict[str, str] = {}
    if args.catalog_json and args.catalog_json.exists():
        cat_raw = json.loads(args.catalog_json.read_text(encoding="utf-8"))
        cat_tracks = cat_raw.get("tracks", []) if isinstance(cat_raw, dict) else cat_raw
        for ct in cat_tracks:
            if isinstance(ct, dict) and ct.get("id") and ct.get("local_path"):
                cat_path_by_id[ct["id"]] = str(ct["local_path"])

    cache_src = args.from_cache
    if cache_src is None and not args.reanalyze_local and args.manifest is None and (STAGING_DIR / "raw_dsp_559.json").exists():
        cache_src = STAGING_DIR / "raw_dsp_559.json"

    if cache_src and cache_src.exists():
        loaded = json.loads(cache_src.read_text(encoding="utf-8"))
        analyzed = loaded.get("tracks", []) if isinstance(loaded, dict) else loaded
        for t in analyzed:
            enrich_track_tiers(t)
    else:
        ffmpeg_bin = shutil.which("ffmpeg")
        if not ffmpeg_bin:
            raise SystemExit("ffmpeg not found on PATH")
        if args.reanalyze_local:
            in_tracks = base_payload.get("tracks", [])
            if not in_tracks:
                raise SystemExit(f"No tracks found in {args.data_js}")
        elif args.manifest and args.manifest.exists():
            in_tracks = json.loads(args.manifest.read_text(encoding="utf-8")).get("tracks", [])
        else:
            ap.error("Specify --reanalyze-local, --manifest, or --from-cache")

        for t_in in in_tracks:
            if not t_in.get("local_path") and t_in.get("id") in cat_path_by_id:
                t_in["local_path"] = cat_path_by_id[t_in["id"]]

        analyzed = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = [pool.submit(reanalyze_track_worker, ffmpeg_bin, ROOT, t) for t in in_tracks]
            for fut in as_completed(futs):
                analyzed.append(fut.result())

    # Join local_path and preserve preview clip metadata before scoring
    preview_keep_keys = (
        "bytes", "duration_sec", "clip_bars", "beat_sec", "bar_sec",
        "beat_phase_sec", "cue_sec", "rms_db", "gain_trim", "preview_url", "file",
        "mp3_320_url", "mp3_url", "mp3_320_bytes", "mp3_size_mb", "mp3_mb", "mp3_kbps",
        "flac_url", "flac_bytes", "flac_size_mb", "flac_mb",
    )
    for t in analyzed:
        tid = t["id"]
        if not t.get("local_path") and tid in cat_path_by_id:
            t["local_path"] = cat_path_by_id[tid]
        b_prev = baseline_by_id.get(tid)
        if b_prev:
            for pk in preview_keep_keys:
                if pk not in t and pk in b_prev:
                    t[pk] = b_prev[pk]

    era_rank = {e: idx for idx, e in enumerate(ERA_ORDER)}
    analyzed.sort(key=lambda t: (era_rank.get(t["era"], 99), int(t.get("slot", 0)), t["id"]))
    if args.cache_json:
        args.cache_json.parent.mkdir(parents=True, exist_ok=True)
        args.cache_json.write_text(json.dumps(analyzed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    ml_index = {} if args.no_ml_scores else load_ml_genre_predictions(args.ml_scores)
    if ml_index:
        print(f"Loaded ML genre predictions from {args.ml_scores} ({len(ml_index)} lookup keys)")

    # Score ALL tracks first (including calibration-only tracks like hd_2005_35 Selling demo!)
    calibration_ids = ("hd_2005_35", "hd_2005_50", "archive_2013_18_58", "hd_2005_27", "hd_2005_26")
    calibration_checks: dict[str, dict] = {}
    for t in analyzed:
        best_arch = recalibrate_and_score_track(t, ml_index=ml_index, w_folder=args.w_folder, w_dsp=args.w_dsp, w_ml=args.w_ml)
        if t["id"] in calibration_ids:
            top3 = sorted(t["genre_scores"].items(), key=lambda kv: kv[1], reverse=True)[:3]
            calibration_checks[t["id"]] = {
                "title": t["title"],
                "predicted_archetype": best_arch,
                "predicted_label": ARCH_LABELS[best_arch],
                "rock_score": t["rock_score"],
                "ambient_rock_score": t["ambient_rock_score"],
                "guitar_demo_score": t["guitar_demo_score"],
                "drum_complexity": t["drum_complexity"],
                "top3": top3,
            }
            print(f"[CALIBRATION] {t['id']} ({t['title']}) -> {best_arch} ({ARCH_LABELS[best_arch]}), top3={top3}")

    excluded_ids = set() if args.keep_excluded else load_excluded_ids(args.exclusions_json)
    if not args.keep_excluded:
        before_n = len(analyzed)
        analyzed = [
            t for t in analyzed
            if t["id"] not in excluded_ids
            and not is_excluded_by_folder_rule(str(t.get("local_path") or cat_path_by_id.get(t["id"]) or ""))
        ]
        print(f"Filtered exclusions ({before_n} -> {len(analyzed)} tracks; {before_n - len(analyzed)} excluded)")

    layout = cluster_and_layout(analyzed)

    # Strip private local filesystem paths before writing analysis payload
    private_keys = ("local_path", "rel_path", "slug", "source_codec", "raw_drum_complexity", "raw_four_on_floor", "raw_breakbeat_score", "genre_scores")
    for t in analyzed:
        for pk in private_keys:
            t.pop(pk, None)

    by_id = {t["id"]: t for t in analyzed}

    meta = dict(base_payload.get("meta", {}))
    meta.update({
        "total_map_tracks": len(analyzed),
        "silhouette": layout["silhouette"],
        "style_groups": layout["style_groups"],
        "era_anchors": layout["era_anchors"],
        "track_near": layout["track_near"],
        "track_map": layout["track_map"],
        "calibration_checks": calibration_checks,
    })

    eras = base_payload.get("eras", [])
    for er in eras:
        er_tracks = [t for t in analyzed if t["era"] == er["id"]]
        er["tracks"] = er_tracks
        er["audio_files"] = len(er_tracks)
    phases = base_payload.get("phases", [])
    for ph in phases:
        ph_tracks = [by_id[t["id"]] for t in ph.get("tracks", []) if t["id"] in by_id]
        ph["tracks"] = ph_tracks

    out_payload = {"meta": meta, "tracks": analyzed, "phases": phases, "eras": eras}
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(out_payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Analyzed {len(analyzed)} tracks -> {args.out_json} (silhouette={layout['silhouette']}, clusters={len(layout['style_groups'])})")
    for g in layout["style_groups"]:
        names = [by_id[m]["title"] for m in g["members"]]
        print(f"  [{g['id']}] {g['label']} ({len(names)}): {', '.join(names[:6])}{' ...' if len(names) > 6 else ''}")


if __name__ == "__main__":
    main()

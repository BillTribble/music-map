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


def analyze_harmony_and_rhythm(y: np.ndarray, bpm_est: float) -> dict:
    """Compute HPSS chromagram macro harmonic complexity, modal darkness, microtonal index, and drum complexity."""
    sr = float(dsp_models.SR)
    nfft = 2048
    hop = 512
    nfr = 1 + max(0, (len(y) - nfft) // hop)
    if nfr < 24:
        return {
            "key_camelot": "5A", "key_label": "Cm", "tonic_pc": 0,
            "chord_richness": 45.0, "harmonic_motion": 40.0, "modal_darkness": 50.0,
            "microtonal_score": 15.0, "harmonic_complexity": 45.0,
            "drum_complexity": 35.0, "perc_share": 0.25, "syncopation": 0.4,
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

    perc_share = float(P_p.sum() / (P_h.sum() + P_p.sum() + 1e-12))

    # Map FFT bins (55 Hz .. 2400 Hz) onto 12 pitch classes
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    mask_pitch = (freqs >= 55.0) & (freqs <= 2400.0)
    f_p = freqs[mask_pitch]
    midi_f = 69.0 + 12.0 * np.log2(f_p / 440.0)
    pc_bin = np.round(midi_f).astype(int) % 12
    # Tuning offset in semitones (-0.5..+0.5) per active pitch bin weighted by spectral energy
    dev_st = np.abs(midi_f - np.round(midi_f))

    chroma = np.zeros((12, P_h.shape[1]), dtype=np.float64)
    P_sub = P_h[mask_pitch, :]
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

    # High-to-low percussive complexity ratio (hi-hats/ghost snares/breaks vs pure thump or ambient)
    high_low_ratio = float(p_env_high.mean() / (p_env_low.mean() + p_env_high.mean() + 1e-9))

    # Calibrate 0..100 Drum Complexity, gating rhythm detail by actual percussive presence
    # so beatless ambient washes (perc_share < 0.05) do not score false high complexity from pad ripples.
    s_perc = clamp(perc_share / 0.42 * 100.0)
    s_rate = clamp(perc_onset_rate / 7.5 * 100.0)
    s_sync = clamp((gap_cv / 1.15 * 55.0) + (clamp(gap_ent * 100.0, 0, 100) * 0.45))
    s_hl = clamp(high_low_ratio * 100.0)
    presence = clamp(perc_share / 0.16, 0.0, 1.0) ** 0.85
    drum_complexity = clamp(0.35 * s_perc + presence * (0.30 * s_rate + 0.22 * s_sync + 0.13 * s_hl))

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
        "drum_complexity": round(drum_complexity, 1),
        "perc_share": round(perc_share, 3),
        "perc_onset_rate": round(perc_onset_rate, 2),
        "gap_entropy": round(gap_ent, 3),
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
    pulse = t["pulse_clarity"]
    if dc < 24 and pc < 0.14:
        r_tag = "Beatless ambient wash"
    elif dc < 36:
        r_tag = "Spacious / minimal pulse"
    elif bpm >= 158 and dc >= 52:
        r_tag = "Fast D&B breakbeats"
    elif t["era"] == "bands_archive" and dc >= 45:
        r_tag = "Live band drums"
    elif pulse >= 0.34 and en >= 6 and dc >= 42:
        r_tag = "Driven 4/4 house groove"
    elif dc >= 60:
        r_tag = "Intricate syncopated drums"
    elif en <= 5:
        r_tag = "Chill downtempo groove"
    else:
        r_tag = "Steady electronic beat"

    return h_tag, r_tag


def gate_rhythm_features(t: dict) -> None:
    """Ensure drum_complexity and drum_pulse reflect actual percussive presence."""
    pc = float(t.get("perc_share", 0.0))
    dc_val = float(t.get("drum_complexity", 0.0))
    if not t.get("_dc_gated"):
        presence = min(1.0, max(0.0, pc / 0.16)) ** 0.85
        s_perc = min(100.0, pc / 0.42 * 100.0)
        detail = max(0.0, dc_val - 0.35 * s_perc)
        t["drum_complexity"] = round(min(100.0, 0.35 * s_perc + detail * presence), 1)
        t["_dc_gated"] = True
    pul_presence = min(1.0, max(0.0, (pc - 0.02) / 0.12))
    t["drum_pulse"] = round(float(t.get("pulse_clarity", 0.0)) * pul_presence * 100.0, 1)


def cluster_and_layout(tracks: list[dict]) -> dict:
    """Cluster tracks into cohesive musical style groups and project both Similarity & Era 2D maps."""
    for t in tracks:
        gate_rhythm_features(t)

    # Focused 7-feature similarity space aligned with Energy, Drums, 4/4 Pulse, and Macro Harmony
    weights = np.array([
        2.20,  # MIK Energy (1-10)
        2.30,  # Gated Drum Complexity
        1.70,  # Drum-gated 4/4 Pulse Clarity
        1.35,  # Macro Harmonic Complexity
        0.75,  # Chord Richness
        0.55,  # Harmonic Motion
        0.45,  # Modal Darkness
    ])
    X_raw = np.array([
        [
            t["energy"],
            t["drum_complexity"],
            t["drum_pulse"],
            t["harmonic_complexity"],
            t["chord_richness"],
            t["harmonic_motion"],
            t["modal_darkness"],
        ]
        for t in tracks
    ], dtype=np.float64)
    X_std = StandardScaler().fit_transform(X_raw) * weights
    D = np.linalg.norm(X_std[:, None, :] - X_std[None, :, :], axis=2)

    # Choose optimal Ward cluster count between 5 and 6 via silhouette, preferring 6 clear archetypes
    best_sc, best_k, best_labels = -1.0, 6, None
    for k in (5, 6):
        lab = AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(X_std)
        sc = float(silhouette_score(X_std, lab))
        score_adj = sc + (0.015 if k == 6 else 0.0)
        if score_adj > best_sc:
            best_sc, best_k, best_labels = score_adj, k, lab
            raw_sc = sc
    best_sc = raw_sc

    # Build raw cluster stats
    clusters_raw = []
    for cid in range(best_k):
        idxs = [i for i, l in enumerate(best_labels) if l == cid]
        clusters_raw.append({
            "orig_id": cid,
            "idxs": idxs,
            "en": float(np.mean([tracks[i]["energy"] for i in idxs])),
            "dc": float(np.mean([tracks[i]["drum_complexity"] for i in idxs])),
            "dp": float(np.mean([tracks[i]["drum_pulse"] for i in idxs])),
            "perc": float(np.mean([tracks[i]["perc_share"] for i in idxs])),
            "hc": float(np.mean([tracks[i]["harmonic_complexity"] for i in idxs])),
            "cr": float(np.mean([tracks[i]["chord_richness"] for i in idxs])),
            "micro": float(np.mean([tracks[i]["microtonal_score"] for i in idxs])),
        })

    # Order clusters smoothly from quiet Ambient -> Chill -> Downtempo Lush -> Hypnotic -> House -> Complex Drums
    clusters_raw.sort(key=lambda c: (c["dc"] >= 24, c["en"], c["dc"]))
    T_PALETTE_HUES = [205, 165, 275, 35, 130, 340]

    archetypes = [
        ("ambient", "Ambient & meditative", lambda c: (120.0 if c["dc"] < 24 else 0.0) + (10 - c["en"]) * 3.0 - c["dc"] * 0.4),
        ("downtempo_lush", "Downtempo & lush chords", lambda c: (110.0 if c["en"] <= 3.2 and c["hc"] >= 54 and c["dc"] >= 28 else 0.0) + c["cr"] * 0.6 - c["en"] * 5.0),
        ("chill_elec", "Chill & sparse electronic", lambda c: (100.0 if 24 <= c["dc"] < 38 else 0.0) + (6.0 - abs(c["en"] - 4.0)) * 3.0 - c["cr"] * 0.3),
        ("dnb_breaks", "Complex drums & breaks", lambda c: c["dc"] * 1.4 + c["en"] * 8.0 + c["perc"] * 50.0),
        ("house_ecstatic", "House & ecstatic groove", lambda c: c["dp"] * 1.2 + c["cr"] * 0.7 + c["hc"] * 0.5 + c["en"] * 3.0),
        ("hypnotic_micro", "Hypnotic electro & microtonal", lambda c: (60.0 if c["hc"] < 46 and c["dp"] >= 40 else 0.0) + c["micro"] * 0.4 + c["dp"] * 0.3),
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
        min_y = float(np.min(xy[c["idxs"], 1]))
        member_ids = [tracks[i]["id"] for i in c["idxs"]]
        for i in c["idxs"]:
            tracks[i]["cluster_id"] = gid
            tracks[i]["cluster_label"] = alabel
            tracks[i]["cluster_idx"] = gi
            h_tag, r_tag = make_tags(tracks[i])
            tracks[i]["harmony_tag"] = h_tag
            tracks[i]["rhythm_tag"] = r_tag
        style_groups.append({
            "id": gid,
            "label": alabel,
            "idx": gi,
            "hue": T_PALETTE_HUES[gi % len(T_PALETTE_HUES)],
            "members": member_ids,
            "cx": round(float(cent[0]), 4),
            "cy": round(float(max(0.05, min_y - 0.035)), 4),
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
    analyzed_tracks = []

    try:
        for tid, (src_kind, era, slot, title, default_bpm, src, fixed_cue) in resolved_sources.items():
            # Keep existing 24 MP3 tracks' calibrated BPM so their Beat-1 loops stay sample-exact!
            is_existing = (ROOT / "audio" / f"{tid}.mp3").exists() and tid != "new"
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

            # Determine BPM (for new tracks compute from MIK or DSP with genre-aware octave handling)
            if is_existing:
                bpm = float(default_bpm)
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
                f"[{tid:22s}] En={energy:2d} ({energy_source:9s}) | {bpm:6.2f} BPM | {key_label:11s} "
                f"| Harm={hr['harmonic_complexity']:4.1f} ({h_tag}) | Drum={hr['drum_complexity']:4.1f} ({r_tag})"
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

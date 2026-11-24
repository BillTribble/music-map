#!/usr/bin/env python3
"""Pure-stdlib data builder for the Music Evolution Explorer web app.

Reads precomputed corpus distributions, deduplicated MIDI clip JSONs,
Mixed In Key + DSP macro analysis (scripts/track_analysis.json), and
audio_manifest.json, emitting js/data.js with zero local filesystem paths.
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path.home() / ".agents" / "skills" / "bill-music" / "assets"
OUT_JS = ROOT / "js" / "data.js"

PHASE_META = [
    ("phase0_archive", "Phase 0: Archive", "P0 Archive", "2001–2014", "Early DAWs & Archive"),
    ("phase1_early", "Phase 1: Early", "P1 Early", "2013–2018", "Live 8–10"),
    ("phase2_mid", "Phase 2: Mid", "P2 Mid", "2018–2022", "Live 10"),
    ("phase3_ambient", "Phase 3: Ambient", "P3 Ambient", "2020–2024", "Live 10→12"),
    ("phase4_recent", "Phase 4: Recent", "P4 Recent", "2024–2026", "Live 12"),
]

ARCHIVE_ERAS = ["present_ambient", "present_electro", "hd_2005", "bands_archive"]

ERA_META = [
    ("present_ambient", "Present Ambient", "Pres Amb", "2001–12", "phase0_archive", "P0", "Early ambient sketches"),
    ("present_electro", "Present Electro", "Pres Elec", "2003–12", "phase0_archive", "P0", "Early electro & chiptune"),
    ("hd_2005", "2005 Hard Drive", "2005 HD", "2005–10", "phase0_archive", "P0", "Archival bounces & mixes"),
    ("bands_archive", "Archive 2006–14", "Arch 06", "2006–14", "phase0_archive", "P0", "Spudboy & 2006–14 solo archive"),
    ("archive_2013_18", "Archive 13–18", "Arch 13", "2013–18", "phase1_early", "P1", ""),
    ("nihon_forever", "Nihon Forever", "Nihon", "~2015–17", "phase1_early", "P1", ""),
    ("ep_concepts", "EP Concepts", "EP Conc", "~2016–18", "phase1_early", "P1", "Includes 'Le Garage ≤2018' folder"),
    ("le_garage", "Le Garage", "Garage", "2018–19", "phase2_mid", "P2", "Le Garage Hermétique (5/9 microtonal or gamelan)"),
    ("psychedailies", "Psychedailies", "Psych", "2019–21", "phase2_mid", "P2", "Audio-first sketches"),
    ("archive_2018_23", "Archive 18–23", "Arch 18", "2018–23", "phase2_mid", "P2", "Audio-heavy archive"),
    ("spirit_guides", "Spirit Guides", "Spirit", "~2020–22", "phase3_ambient", "P3", ""),
    ("lucid_crystal", "Lucid Crystal", "Lucid", "~2021–23", "phase3_ambient", "P3", ""),
    ("remixes_commissions", "Remixes/Comm.", "Remix", "2020–24", "phase3_ambient", "P3", ""),
    ("sketches_2024_25", "Sketches 24–25", "Sk 24", "2024–25", "phase4_recent", "P4", "Audio/AI-stem sketches"),
    ("ecstatic_wave", "Ecstatic Wave", "Ecstatic", "2024–25", "phase4_recent", "P4", ""),
    ("sketches_2026", "Sketches 2026", "Sk 26", "2026", "phase4_recent", "P4", ""),
]

FINE_HARMONY_KEYS = [
    "dyad_5th",
    "dyad_4th",
    "dyad_3rd_6th",
    "dyad_2nd_m7",
    "dyad_semitone_M7",
    "dyad_tritone",
    "maj_triad",
    "min_triad",
    "sus2_4",
    "dim_aug",
    "maj7",
    "min7",
    "dom7",
    "extended_9_11",
    "quartal_cluster",
]

COF_ORDER = ["C", "G", "D", "A", "E", "B", "F#", "C#", "Ab", "Eb", "Bb", "F"]
ENHARMONIC = {
    "Db": "C#",
    "D#": "Eb",
    "Gb": "F#",
    "G#": "Ab",
    "A#": "Bb",
}

DEGREE_LABELS = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"]

CURATED_MICROTONAL = {
    "nihon_forever": {
        "ji_retune_projects": 1,
        "gamelan_projects": 0,
        "distinct_projects": 1,
        "evidence": [
            "07 Funabashi Massive — Retune for Live Transmitter/Receiver microtonal.amxd",
        ],
    },
    "ep_concepts": {
        "ji_retune_projects": 5,
        "gamelan_projects": 3,
        "distinct_projects": 7,
        "evidence": [
            "Eli on the Ropes (10 just hi) — Just Intonation pad/arp/lead stems",
            "Dance of the Ascendant Artificed (17 just trim) — Just Intonation synth/Quantore",
            "Underground Forest (autodance) — Retune microtonal simple JI.adg + AfroDJMac Tuned 808 JI.adg",
            "Tower Children (embrace) — Retune for Live microtonal + Tuned 808 JI",
            "Dusty Circuit Sketch — 06 semera tuning (Semaradana) + 14 Gamelan rendered",
            "TempleGong City — Gamelan/gong tonal percussion",
            "Mikro Trash — Retune for Live microtonal + gong",
        ],
    },
    "le_garage": {
        "ji_retune_projects": 1,
        "gamelan_projects": 4,
        "distinct_projects": 5,
        "evidence": [
            "01 Firefly Dance — Gamelan track + firefly stem gamelan-1.aif",
            "03 Tar Hai (Dragon Tamer Bells) — Gamelan bells riff foundation",
            "05 Nagual (Subterranean - Quant FM) — Retune for Live microtonal.amxd + Imposcar micro 6th chord.adg",
            "07 Major Grubert — gamelan track + semera-choir-1 & 2 (Balinese Semaradana)",
            "08 Sacred Songs Chiram (semeradana) — Mikro Prism in 7-tone Balinese Semaradana tuning",
        ],
    },
    "archive_2018_23": {
        "ji_retune_projects": 0,
        "gamelan_projects": 1,
        "distinct_projects": 1,
        "evidence": [
            "2019 Sketches — gamelan test & fugue test gamelan",
        ],
    },
    "psychedailies": {
        "ji_retune_projects": 0,
        "gamelan_projects": 1,
        "distinct_projects": 1,
        "evidence": [
            "Season 1 #17 — gong percussion sketch",
        ],
    },
    "remixes_commissions": {
        "ji_retune_projects": 0,
        "gamelan_projects": 1,
        "distinct_projects": 1,
        "evidence": [
            "Gamelan Ladrang Remix — Javanese ladrang cycle",
        ],
    },
}

TUNING_SCALES = {
    "ji_5_7": {
        "id": "ji_5_7",
        "name": "5/7-Limit Just Intonation",
        "subtitle": "Retune microtonal simple JI / Tuned 808 JI",
        "source_note": "Pure integer ratios used via Retune for Live Transmitter/Receiver & Tuned 808 JI racks in Le Garage-era projects.",
        "degrees": [
            {"deg": "1/1", "cents": 0.0, "note": "Root (0.0¢)"},
            {"deg": "16/15", "cents": 111.7, "note": "JI b2 (+11.7¢ vs 12-TET)"},
            {"deg": "9/8", "cents": 203.9, "note": "Major 2nd (+3.9¢)"},
            {"deg": "6/5", "cents": 315.6, "note": "JI Minor 3rd (+15.6¢)"},
            {"deg": "5/4", "cents": 386.3, "note": "Pure Major 3rd (-13.7¢)"},
            {"deg": "4/3", "cents": 498.0, "note": "Perfect 4th (-2.0¢)"},
            {"deg": "7/5", "cents": 582.5, "note": "Septimal Tritone (-17.5¢)"},
            {"deg": "3/2", "cents": 702.0, "note": "Pure Fifth (+2.0¢)"},
            {"deg": "8/5", "cents": 813.7, "note": "JI Minor 6th (+13.7¢)"},
            {"deg": "5/3", "cents": 884.4, "note": "Pure Major 6th (-15.6¢)"},
            {"deg": "7/4", "cents": 968.8, "note": "Harmonic 7th (-31.2¢)"},
            {"deg": "15/8", "cents": 1088.3, "note": "Pure Maj 7th (-11.7¢)"},
            {"deg": "2/1", "cents": 1200.0, "note": "Octave (0.0¢)"},
        ],
    },
    "semeradana": {
        "id": "semeradana",
        "name": "Balinese Gamelan Semaradana",
        "subtitle": "7-Tone Saih Pitu (semera tuning)",
        "source_note": "Representative Balinese 7-tone Semaradana cent profile (with paired ombak shimmering beat detuning) matching Sacred Songs Chiram & Major Grubert.",
        "degrees": [
            {"deg": "Ding (1)", "cents": 0.0, "note": "Tonic gong (0¢)"},
            {"deg": "Dong (2)", "cents": 138.0, "note": "Narrow Pelog step (+38¢)"},
            {"deg": "Deng (3)", "cents": 284.0, "note": "Low Pelog 3rd (-16¢)"},
            {"deg": "Deung (4)", "cents": 536.0, "note": "Stretched 4th (+36¢)"},
            {"deg": "Dung (5)", "cents": 694.0, "note": "Beating 5th (-6¢, ombak)"},
            {"deg": "Dang (6)", "cents": 818.0, "note": "Pelog 6th (+18¢)"},
            {"deg": "Daing (7)", "cents": 1052.0, "note": "High 7th (+52¢)"},
            {"deg": "Ding (8)", "cents": 1200.0, "note": "Octave (+ombak shimmer)"},
        ],
    },
    "alves_pelog": {
        "id": "alves_pelog",
        "name": "Bill Alves JI Pelog",
        "subtitle": "alves_pelog.scl (corpus Scala library)",
        "source_note": "Exact ratios from alves_pelog.scl in Bill's corpus Scala tuning archive (1/1 = 293.33 Hz).",
        "degrees": [
            {"deg": "1/1", "cents": 0.0, "note": "Tonic (0.0¢)"},
            {"deg": "8/7", "cents": 231.2, "note": "Septimal 2nd (+31.2¢)"},
            {"deg": "6/5", "cents": 315.6, "note": "JI Minor 3rd (+15.6¢)"},
            {"deg": "21/16", "cents": 470.8, "note": "Septimal 4th (-29.2¢)"},
            {"deg": "3/2", "cents": 702.0, "note": "Pure 5th (+2.0¢)"},
            {"deg": "8/5", "cents": 813.7, "note": "JI Minor 6th (+13.7¢)"},
            {"deg": "7/4", "cents": 968.8, "note": "Harmonic 7th (-31.2¢)"},
            {"deg": "2/1", "cents": 1200.0, "note": "Octave (0.0¢)"},
        ],
    },
    "alves_slendro": {
        "id": "alves_slendro",
        "name": "Bill Alves JI Slendro",
        "subtitle": "alves_slendro.scl (corpus Scala library)",
        "source_note": "Exact 5-tone JI ratios from alves_slendro.scl for Gender Barung in Bill's corpus Scala tuning archive.",
        "degrees": [
            {"deg": "1/1", "cents": 0.0, "note": "Tonic (0.0¢)"},
            {"deg": "8/7", "cents": 231.2, "note": "Wide Step 2 (+31.2¢)"},
            {"deg": "4/3", "cents": 498.0, "note": "Pure 4th (-2.0¢)"},
            {"deg": "14/9", "cents": 764.9, "note": "Neut. 5th/6th (-35.1¢)"},
            {"deg": "16/9", "cents": 996.1, "note": "Pyth. b7 (-3.9¢)"},
            {"deg": "2/1", "cents": 1200.0, "note": "Octave (0.0¢)"},
        ],
    },
}


def r1(x):
    return round(float(x), 1) if x is not None else None


def pct(vals: list[float], q: float):
    if not vals:
        return None
    s = sorted(vals)
    idx = (len(s) - 1) * (q / 100.0)
    lo = int(idx)
    hi = min(lo + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (idx - lo), 1)


def dev_name(it) -> str:
    if isinstance(it, dict):
        return str(it.get("name", ""))
    if isinstance(it, (list, tuple)) and it:
        return str(it[0])
    return str(it)


def classify_fine_harmony(pcs: set[int], bass_pc: int) -> str:
    n = len(pcs)
    ordered = [bass_pc] + sorted(pc for pc in pcs if pc != bass_pc)
    if n == 2:
        other_pc = next(pc for pc in pcs if pc != bass_pc)
        up_iv = (other_pc - bass_pc) % 12
        if up_iv == 7:
            return "dyad_5th"
        if up_iv == 5:
            return "dyad_4th"
        if up_iv in (3, 4, 8, 9):
            return "dyad_3rd_6th"
        if up_iv in (2, 10):
            return "dyad_2nd_m7"
        if up_iv in (1, 11):
            return "dyad_semitone_M7"
        return "dyad_tritone"

    for r in ordered:
        ivs = frozenset((pc - r) % 12 for pc in pcs)
        if ivs == frozenset({0, 4, 7}):
            return "maj_triad"
        if ivs == frozenset({0, 3, 7}):
            return "min_triad"
        if ivs in (frozenset({0, 2, 7}), frozenset({0, 5, 7})):
            return "sus2_4"
        if ivs in (frozenset({0, 3, 6}), frozenset({0, 4, 8}), frozenset({0, 3, 6, 9}), frozenset({0, 3, 6, 10})):
            return "dim_aug"
        if ivs == frozenset({0, 4, 7, 11}) or ivs == frozenset({0, 4, 11}):
            return "maj7"
        if ivs == frozenset({0, 3, 7, 10}) or ivs == frozenset({0, 3, 10}):
            return "min7"
        if ivs == frozenset({0, 4, 7, 10}) or ivs == frozenset({0, 4, 10}):
            return "dom7"

    for r in ordered:
        ivs = frozenset((pc - r) % 12 for pc in pcs)
        if ivs in (
            frozenset({0, 4, 7, 11, 2}),
            frozenset({0, 3, 7, 10, 2}),
            frozenset({0, 3, 10, 2}),
            frozenset({0, 4, 7, 10, 2}),
        ):
            return "extended_9_11"
        if n >= 4 and ({0, 3, 7}.issubset(ivs) or {0, 4, 7}.issubset(ivs)):
            return "extended_9_11"
    return "quartal_cluster"


def compute_chord_clusters(projects: list[dict]) -> tuple[dict, dict]:
    """Extract deduplicated simultaneous chord/dyad taxonomy and voicing registers."""
    seen = set()
    quals: Counter = Counter()
    lows: list[float] = []
    highs: list[float] = []
    spans: list[float] = []

    for proj in projects:
        for c in proj.get("midi_clips", []):
            if c.get("track_muted") or c.get("is_ref_midi"):
                continue
            role = c.get("pitch_role_guess")
            if role not in ("lead_melody", "bass", "chords_pads", "arp_seq"):
                continue
            sig = (
                role,
                round(float(c["loop_len"]), 2),
                tuple(
                    (int(n[0]), round(float(n[1]), 3), round(float(n[2]), 3), int(round(float(n[3]))))
                    for n in c["notes"]
                ),
            )
            if sig in seen:
                continue
            seen.add(sig)
            shift = int(c.get("midi_pitch_shift") or 0)
            notes = sorted(
                [[int(n[0]) + shift, float(n[1]), float(n[2]), float(n[3])] for n in c["notes"] if float(n[2]) > 0],
                key=lambda x: (x[1], x[0]),
            )
            if len(notes) < 2:
                continue
            clusters = [[notes[0]]]
            for n in notes[1:]:
                if n[1] - clusters[-1][0][1] <= 0.10:
                    clusters[-1].append(n)
                else:
                    clusters.append([n])
            for cl in clusters:
                pcs = {int(x[0]) % 12 for x in cl}
                if len(pcs) >= 2:
                    ps = [int(x[0]) for x in cl]
                    bass_pc = min(ps) % 12
                    quals[classify_fine_harmony(pcs, bass_pc)] += 1
                    lows.append(float(min(ps)))
                    highs.append(float(max(ps)))
                    spans.append(float(max(ps) - min(ps)))

    tot = sum(quals.values())
    counts = {k: quals.get(k, 0) for k in FINE_HARMONY_KEYS}
    pcts = {
        k: (round(counts[k] * 100.0 / tot, 1) if tot > 0 else None)
        for k in FINE_HARMONY_KEYS
    }
    fine_harmony = {
        "n_chords": tot,
        "low_sample": tot < 25,
        "counts": counts,
        "pcts": pcts,
    }
    voicing_register = {
        "low_p10": pct(lows, 10),
        "low_p25": pct(lows, 25),
        "low_p50": pct(lows, 50),
        "high_p50": pct(highs, 50),
        "high_p75": pct(highs, 75),
        "high_p90": pct(highs, 90),
        "span_p10": pct(spans, 10),
        "span_p25": pct(spans, 25),
        "span_p50": pct(spans, 50),
        "span_p75": pct(spans, 75),
        "span_p90": pct(spans, 90),
    }
    return fine_harmony, voicing_register


def compute_root_motion(m_obj: dict) -> dict:
    ap = m_obj.get("roles", {}).get("all_pitched", {})
    rm_raw = ap.get("harmony", {}).get("root_motion_semitones", {})
    counts_12 = [int(rm_raw.get(str(i), 0)) for i in range(12)]
    n_total = sum(counts_12)
    n_moves = sum(counts_12[1:])
    pedal_pct = round(counts_12[0] * 100.0 / n_total, 1) if n_total > 0 else None

    def move_pct(indices: tuple[int, ...]):
        if n_moves <= 0:
            return None
        return round(sum(counts_12[i] for i in indices) * 100.0 / n_moves, 1)

    return {
        "n_total": n_total,
        "n_moves": n_moves,
        "counts_12": counts_12,
        "pedal_pct": pedal_pct,
        "semitone_1_11": move_pct((1, 11)),
        "wholestep_2_10": move_pct((2, 10)),
        "min3_3_9": move_pct((3, 9)),
        "maj3_4_8": move_pct((4, 8)),
        "fourth_fifth_5_7": move_pct((5, 7)),
        "tritone_6": move_pct((6,)),
    }


def compute_scale_and_roots(m_obj: dict, a_obj: dict | None) -> tuple[dict, list[int]]:
    m_km = m_obj.get("key_mode", {})
    a_km = (a_obj or {}).get("key_mode", {})

    m_sd = m_km.get("scale_degree_hist_12")
    a_sd = a_km.get("scale_degree_hist_12")
    if m_sd and sum(m_sd) > 0:
        msum = sum(m_sd)
        midi_12 = [round(v / msum, 4) for v in m_sd]
    else:
        midi_12 = None

    if a_sd and sum(a_sd) > 0:
        asum = sum(a_sd)
        audio_12 = [round(v / asum, 4) for v in a_sd]
    else:
        audio_12 = None

    wm = int(m_km.get("n_projects_with_pitched_midi") or 0) if midi_12 else 0
    wa = int((a_obj or {}).get("n_files") or 0) if audio_12 else 0
    if wm + wa > 0:
        blended = []
        for i in range(12):
            val = (wm * (midi_12[i] if midi_12 else 0.0)) + (wa * (audio_12[i] if audio_12 else 0.0))
            blended.append(val)
        bsum = sum(blended) or 1.0
        combined_12 = [round(v / bsum, 4) for v in blended]
    else:
        combined_12 = None

    # Combine MIDI + Audio roots in Circle-of-Fifths order
    root_counts: Counter = Counter()
    for src in (m_km.get("top_roots", {}), a_km.get("top_roots", {})):
        for rk, rv in src.items():
            norm_k = ENHARMONIC.get(rk, rk)
            root_counts[norm_k] += int(rv)
    roots_12 = [root_counts.get(rname, 0) for rname in COF_ORDER]

    return {
        "labels": DEGREE_LABELS,
        "midi_12": midi_12,
        "audio_12": audio_12,
        "combined_12": combined_12,
    }, roots_12


def compute_microtonal(key_id: str, eras_in_phase: list[str] | None, a_obj: dict | None) -> dict:
    off = (a_obj or {}).get("expressive_micro_pitch", {}).get("abs_tuning_offset_cents", {})
    if eras_in_phase is None:
        cur = CURATED_MICROTONAL.get(key_id, {})
        ji = cur.get("ji_retune_projects", 0)
        gam = cur.get("gamelan_projects", 0)
        dist = cur.get("distinct_projects", 0)
        ev = list(cur.get("evidence", []))
    else:
        ji = sum(CURATED_MICROTONAL.get(e, {}).get("ji_retune_projects", 0) for e in eras_in_phase)
        gam = sum(CURATED_MICROTONAL.get(e, {}).get("gamelan_projects", 0) for e in eras_in_phase)
        dist = sum(CURATED_MICROTONAL.get(e, {}).get("distinct_projects", 0) for e in eras_in_phase)
        ev = []
        for e in eras_in_phase:
            ev.extend(CURATED_MICROTONAL.get(e, {}).get("evidence", []))

    return {
        "tuning_offset_p50": r1(off.get("p50")),
        "tuning_offset_p75": r1(off.get("p75")),
        "tuning_offset_mean": r1(off.get("mean")),
        "ji_retune_projects": ji,
        "gamelan_projects": gam,
        "distinct_projects": dist,
        "evidence": ev,
    }


def extract_item(
    key: str,
    label: str,
    short_label: str,
    sublabel: str,
    m_obj: dict,
    a_obj: dict | None,
    projects: list[dict],
    eras_in_phase: list[str] | None = None,
    extra: dict | None = None,
) -> dict:
    roles = m_obj.get("roles", {})
    ap = roles.get("all_pitched", {})
    lm = roles.get("lead_melody", {})
    ba = roles.get("bass", {})
    ch = roles.get("chords_pads", {})
    dr = roles.get("drums", {})

    fine_harmony, voicing_register = compute_chord_clusters(projects)
    root_motion = compute_root_motion(m_obj)
    scale_degrees, roots_12 = compute_scale_and_roots(m_obj, a_obj)
    microtonal = compute_microtonal(key, eras_in_phase, a_obj)

    m_modes = m_obj.get("key_mode", {}).get("mode_counts", {})
    a_modes = (a_obj or {}).get("key_mode", {}).get("mode_counts", {})
    comb_modes: Counter = Counter()
    comb_modes.update(m_modes)
    comb_modes.update(a_modes)
    tot_m = max(1, sum(comb_modes.values()))
    dark_cnt = comb_modes.get("Minor", 0) + comb_modes.get("Phrygian", 0) + comb_modes.get("Dorian", 0)
    harm_min_cnt = comb_modes.get("Harmonic Minor", 0)
    bright_cnt = comb_modes.get("Major", 0) + comb_modes.get("Mixolydian", 0) + comb_modes.get("Lydian", 0)

    p_ref = ap if ap else lm
    mt = p_ref.get("micro_timing", {})
    drm_mt = dr.get("micro_timing", {})
    bass_mt = ba.get("micro_timing", {})

    raw_inst = [dev_name(x) for x in m_obj.get("devices", {}).get("top_instruments", [])]
    top_inst = [n.split(" (")[0] for n in raw_inst if n and "GroupDevice" not in n][:4]
    raw_fx = [dev_name(x) for x in m_obj.get("devices", {}).get("top_effects", [])]
    top_fx = [
        n.replace("Compressor2:", "Comp:")
        for n in raw_fx
        if n and "GroupDevice" not in n and "ProxyInstrumentDevice" not in n
    ][:3]

    a_mp = (a_obj or {}).get("expressive_micro_pitch", {})
    a_iv = (a_obj or {}).get("interval_summary", {})
    lm_iv = lm.get("interval_summary", {})

    # Coarse card pcts (matching STYLE.md buckets)
    hc_ap = ap.get("harmony", {})
    card_raw = hc_ap.get("cardinality_counts", {})
    c2 = int(card_raw.get("2", 0))
    c3 = int(card_raw.get("3", 0))
    c4p = sum(int(cv) for ck, cv in card_raw.items() if ck.isdigit() and int(ck) >= 4)
    tot_c = c2 + c3 + c4p

    out = {
        "id": key,
        "label": label,
        "shortLabel": short_label,
        "sublabel": sublabel,
        "projects": m_obj.get("n_projects", 0),
        "midi_pitched_clips": m_obj.get("n_pitched_clips", 0),
        "midi_drum_clips": m_obj.get("n_drum_clips", 0),
        "midi_pitched_notes": ap.get("n_notes", 0),
        "audio_files": (a_obj or {}).get("n_files", 0),
        "audio_notes": (a_obj or {}).get("n_notes", 0),
        "audio_phrases": (a_obj or {}).get("n_phrases", 0),
        "midi_tracks_med": r1(m_obj.get("arrangement", {}).get("midi_tracks", {}).get("p50")),
        "audio_tracks_med": r1(m_obj.get("arrangement", {}).get("audio_tracks", {}).get("p50")),
        "minutes_med": r1(m_obj.get("arrangement", {}).get("arrangement_minutes", {}).get("p50")),
        "bpm_p25": r1(m_obj.get("tempo", {}).get("p25")),
        "bpm_p50": r1(m_obj.get("tempo", {}).get("p50")),
        "bpm_p75": r1(m_obj.get("tempo", {}).get("p75")),
        "quant_pitched_pct": r1(mt.get("quantized_clip_rate", 0) * 100) if mt else None,
        "quant_bass_pct": r1(bass_mt.get("quantized_clip_rate", 0) * 100) if bass_mt else None,
        "quant_drum_pct": r1(drm_mt.get("quantized_clip_rate", 0) * 100) if drm_mt else None,
        "jitter_ms": r1(mt.get("clip_std_ms", {}).get("p50")),
        "vel_std": r1(p_ref.get("velocity_clip_std", {}).get("p50")),
        "syncopation_pct": r1((p_ref.get("syncopation_rate") or 0) * 100) if p_ref else None,
        "lead_midi_p50": r1(lm.get("register_all_notes", {}).get("p50")),
        "audio_midi_p50": r1((a_obj or {}).get("register_all_notes", {}).get("p50")),
        "bass_midi_p50": r1(ba.get("register_all_notes", {}).get("p50")),
        "lead_step_pct": r1(lm_iv.get("stepwise_pct")) if lm_iv else None,
        "lead_gapfill_pct": r1(lm_iv.get("leap_then_step_fill_pct")) if lm_iv else None,
        "lead_rest_pct": r1(lm.get("rest_ratio", {}).get("p50", 0) * 100) if lm.get("rest_ratio") else None,
        "audio_rest_pct": r1((a_obj or {}).get("rest_ratio", {}).get("p50", 0) * 100) if (a_obj or {}).get("rest_ratio") else None,
        "dyad_pct": r1(c2 * 100.0 / tot_c) if tot_c >= 25 else None,
        "triad_pct": r1(c3 * 100.0 / tot_c) if tot_c >= 25 else None,
        "ext4_pct": r1(c4p * 100.0 / tot_c) if tot_c >= 25 else None,
        "voicing_span_st": r1((hc_ap or ch.get("harmony", {})).get("voicing_span_semitones", {}).get("p50")),
        "dark_modal_pct": r1(dark_cnt * 100.0 / tot_m),
        "harm_min_pct": r1(harm_min_cnt * 100.0 / tot_m),
        "bright_modal_pct": r1(bright_cnt * 100.0 / tot_m),
        "top_modes_midi": [k for k, _ in list(m_modes.items())[:3]],
        "top_modes_audio": [k for k, _ in list(a_modes.items())[:3]],
        "audio_legato_pct": r1((a_obj or {}).get("articulation", {}).get("legato_pct")),
        "midi_legato_pct": r1(lm.get("articulation", {}).get("legato_pct")) if lm.get("articulation") else None,
        "audio_vib_cents": r1(a_mp.get("vibrato_or_bend_cents", {}).get("p50")),
        "audio_glide_cents": r1(a_mp.get("abs_glide_cents", {}).get("p50")),
        "audio_step_pct": r1(a_iv.get("stepwise_pct")) if a_iv else None,
        "audio_sources": (a_obj or {}).get("source_types", {}),
        "top_inst": top_inst,
        "top_fx": top_fx,
        "fine_harmony": fine_harmony,
        "voicing_register": voicing_register,
        "root_motion": root_motion,
        "scale_degrees": scale_degrees,
        "key_roots": {"order": COF_ORDER, "counts": roots_12},
        "microtonal": microtonal,
    }
    if extra:
        out.update(extra)
    return out


def compute_macro_harmony(t_list: list[dict]) -> dict:
    if not t_list:
        return {
            "complexity": 0.0,
            "chord_richness": 0.0,
            "harmonic_motion": 0.0,
            "modal_darkness": 0.0,
            "microtonal": 0.0,
            "mik_energy_med": 0.0,
            "mik_energy_max": 0,
            "drum_complexity_med": 0.0,
            "drum_pulse_med": 0.0,
            "n_analyzed": 0,
        }
    return {
        "complexity": round(statistics.median(t["harmonic_complexity"] for t in t_list), 1),
        "chord_richness": round(statistics.median(t["chord_richness"] for t in t_list), 1),
        "harmonic_motion": round(statistics.median(t["harmonic_motion"] for t in t_list), 1),
        "modal_darkness": round(statistics.median(t["modal_darkness"] for t in t_list), 1),
        "microtonal": round(statistics.median(t["microtonal_score"] for t in t_list), 1),
        "mik_energy_med": round(statistics.median(t["energy"] for t in t_list), 1),
        "mik_energy_max": int(max(t["energy"] for t in t_list)),
        "drum_complexity_med": round(statistics.median(t["drum_complexity"] for t in t_list), 1),
        "drum_pulse_med": round(statistics.median(t.get("drum_pulse", 0.0) for t in t_list), 1),
        "n_analyzed": len(t_list),
    }


def extract_archive_item(
    key: str,
    label: str,
    short_label: str,
    sublabel: str,
    t_list: list[dict],
    extra: dict | None = None,
) -> dict:
    bpms = sorted(float(t["bpm"]) for t in t_list)
    n = len(bpms)
    p25 = round(bpms[max(0, int((n - 1) * 0.25))], 1) if n else None
    p50 = round(statistics.median(bpms), 1) if n else None
    p75 = round(bpms[min(n - 1, int((n - 1) * 0.75))], 1) if n else None

    deg_avg = [0.0] * 12
    for t in t_list:
        sd = t.get("scale_deg_12") or [0.0] * 12
        for i in range(12):
            deg_avg[i] += float(sd[i])
    deg_tot = sum(deg_avg) or 1.0
    combined_12 = [round(v * 100.0 / deg_tot, 1) for v in deg_avg]

    roots_cnt: Counter = Counter()
    minor_cnt = 0
    for t in t_list:
        raw_key = str(t.get("key_label", "C")).split(" (")[0].strip()
        if raw_key.endswith("m"):
            minor_cnt += 1
            tonic = raw_key[:-1]
        else:
            tonic = raw_key
        tonic = ENHARMONIC.get(tonic, tonic)
        if tonic in COF_ORDER:
            roots_cnt[tonic] += 1
    roots_12 = [roots_cnt.get(k, 0) for k in COF_ORDER]

    dark_pct = round(minor_cnt * 100.0 / max(1, n), 1)
    bright_pct = round(100.0 - dark_pct, 1)
    mean_micro = round(statistics.mean(t["microtonal_score"] for t in t_list), 1) if t_list else 0.0
    macro = compute_macro_harmony(t_list)

    out = {
        "id": key,
        "label": label,
        "shortLabel": short_label,
        "sublabel": sublabel,
        "archive_only": True,
        "projects": 0,
        "midi_pitched_clips": 0,
        "midi_drum_clips": 0,
        "midi_pitched_notes": 0,
        "audio_files": n,
        "audio_notes": 0,
        "audio_phrases": 0,
        "midi_tracks_med": None,
        "audio_tracks_med": None,
        "minutes_med": None,
        "bpm_p25": p25,
        "bpm_p50": p50,
        "bpm_p75": p75,
        "quant_pitched_pct": None,
        "quant_bass_pct": None,
        "quant_drum_pct": None,
        "jitter_ms": None,
        "vel_std": None,
        "syncopation_pct": None,
        "lead_midi_p50": None,
        "audio_midi_p50": None,
        "bass_midi_p50": None,
        "lead_step_pct": None,
        "lead_gapfill_pct": None,
        "lead_rest_pct": None,
        "audio_rest_pct": None,
        "dyad_pct": None,
        "triad_pct": None,
        "ext4_pct": None,
        "voicing_span_st": None,
        "dark_modal_pct": dark_pct,
        "harm_min_pct": 0.0,
        "bright_modal_pct": bright_pct,
        "top_modes_midi": [],
        "top_modes_audio": ["Minor" if minor_cnt >= n / 2 else "Major"],
        "audio_legato_pct": None,
        "midi_legato_pct": None,
        "audio_vib_cents": None,
        "audio_glide_cents": None,
        "audio_step_pct": None,
        "audio_sources": {},
        "top_inst": [],
        "top_fx": [],
        "fine_harmony": {},
        "voicing_register": {},
        "root_motion": {},
        "scale_degrees": {
            "labels": DEGREE_LABELS,
            "midi_12": [0.0] * 12,
            "audio_12": combined_12,
            "combined_12": combined_12,
        },
        "key_roots": {"order": COF_ORDER, "counts": roots_12},
        "microtonal": {
            "tuning_offset_p50": None,
            "tuning_offset_p75": None,
            "tuning_offset_mean": None,
            "ji_retune_projects": 0,
            "gamelan_projects": 0,
            "distinct_projects": 0,
            "evidence": [f"Pre-2013 audio archive ({n} tracks, mean microtonal shimmer {mean_micro})"],
        },
        "macro_harmony": macro,
    }
    if extra:
        out.update(extra)
    return out


def main() -> None:
    midi = json.loads((ASSETS_DIR / "style_distributions.json").read_text(encoding="utf-8"))
    audio = json.loads((ASSETS_DIR / "audio_style_distributions.json").read_text(encoding="utf-8"))
    phase_map = midi["metadata"]["phase_map"]

    manifest_path = ROOT / "scripts" / "audio_manifest.json"
    audio_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    raw_by_era = audio_manifest.get("tracks_by_era", {})
    man_by_id = {
        item["id"]: item
        for lst in raw_by_era.values()
        for item in lst
    }

    analysis_path = ROOT / "scripts" / "track_analysis.json"
    ta = json.loads(analysis_path.read_text(encoding="utf-8")) if analysis_path.exists() else {}
    ta_by_id = {t["id"]: t for t in ta.get("tracks", [])}

    merged_tracks: list[dict] = []
    tracks_by_era: dict[str, list[dict]] = defaultdict(list)
    era_order_list = [e[0] for e in ERA_META]
    for eid in era_order_list:
        for m_item in raw_by_era.get(eid, []):
            tid = m_item["id"]
            a_item = ta_by_id.get(tid, {})
            merged = dict(a_item)
            merged.update(m_item)
            merged["era"] = eid
            merged_tracks.append(merged)
            tracks_by_era[eid].append(merged)

    projects_by_era: dict[str, list[dict]] = defaultdict(list)
    for jf in sorted((ASSETS_DIR / "extracted").rglob("*.json")):
        d = json.loads(jf.read_text(encoding="utf-8"))
        projects_by_era[d["era"]].append(d)

    phases_out = []
    for pkey, plabel, pshort, pyears, pdaw in PHASE_META:
        if pkey == "phase0_archive":
            eras_list = list(ARCHIVE_ERAS)
            p_tracks = [t for e in eras_list for t in tracks_by_era[e]]
            p_rep_tracks = []
            for idx_e, e in enumerate(eras_list):
                if tracks_by_era.get(e):
                    t0 = dict(tracks_by_era[e][0])
                    t0["slot"] = idx_e + 1
                    p_rep_tracks.append(t0)
            phases_out.append(
                extract_archive_item(
                    pkey,
                    plabel,
                    pshort,
                    pyears,
                    p_tracks,
                    extra={"daw": pdaw, "note": "Pre-2013 audio archive bounces", "tracks": p_rep_tracks},
                )
            )
            continue

        eras_list = phase_map[pkey]
        p_projects = [proj for e in eras_list for proj in projects_by_era[e]]
        p_all_tracks = [t for e in eras_list for t in tracks_by_era[e]]
        p_tracks = []
        for idx_e, e in enumerate(eras_list):
            if tracks_by_era.get(e):
                t0 = dict(tracks_by_era[e][0])
                t0["slot"] = idx_e + 1
                p_tracks.append(t0)
        phases_out.append(
            extract_item(
                pkey,
                plabel,
                pshort,
                pyears,
                midi["phases"][pkey],
                audio["phases"].get(pkey),
                p_projects,
                eras_in_phase=eras_list,
                extra={
                    "daw": pdaw,
                    "note": "",
                    "tracks": p_tracks,
                    "macro_harmony": compute_macro_harmony(p_all_tracks),
                },
            )
        )

    eras_out = []
    for ekey, elabel, eshort, eyears, ephase, ptag, enote in ERA_META:
        e_tracks = tracks_by_era.get(ekey, [])
        if ekey in ARCHIVE_ERAS:
            eras_out.append(
                extract_archive_item(
                    ekey,
                    elabel,
                    eshort,
                    eyears,
                    e_tracks,
                    extra={"phase": ephase, "phaseTag": ptag, "note": enote, "tracks": e_tracks},
                )
            )
            continue
        eras_out.append(
            extract_item(
                ekey,
                elabel,
                eshort,
                eyears,
                midi["eras"][ekey],
                audio["eras"].get(ekey),
                projects_by_era[ekey],
                eras_in_phase=None,
                extra={
                    "phase": ephase,
                    "phaseTag": ptag,
                    "note": enote,
                    "tracks": e_tracks,
                    "macro_harmony": compute_macro_harmony(e_tracks),
                },
            )
        )

    payload = {
        "meta": {
            "total_projects": 229,
            "total_midi_clips": 1543,
            "total_pitched_audio_files": 448,
            "total_pitched_audio_notes": 36761,
            "total_map_tracks": len(merged_tracks),
            "silhouette": ta.get("silhouette", 0.0),
            "tuning_scales": TUNING_SCALES,
            "cof_order": COF_ORDER,
            "degree_labels": DEGREE_LABELS,
            "fine_harmony_keys": FINE_HARMONY_KEYS,
            "style_groups": ta.get("style_groups", []),
            "era_anchors": ta.get("era_anchors", []),
            "track_near": ta.get("track_near", {}),
            "track_map": ta.get("track_map", {}),
        },
        "tracks": merged_tracks,
        "phases": phases_out,
        "eras": eras_out,
    }

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    js_text = (
        "// Auto-generated corpus, archive, MIK energy, macro harmony & node map data.\n"
        f"window.CORPUS_DATA = {json.dumps(payload, separators=(',', ':'), ensure_ascii=False)};\n"
    )
    OUT_JS.write_text(js_text, encoding="utf-8")
    print(f"Wrote {OUT_JS} ({len(js_text):,} bytes, {len(merged_tracks)} tracks, {len(eras_out)} eras, {len(phases_out)} phases)")


if __name__ == "__main__":
    main()

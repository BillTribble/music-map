#!/usr/bin/env python3
"""Pure-stdlib data builder for the Music Evolution Explorer web app.

Reads precomputed corpus distributions, deduplicated MIDI clip JSONs,
Mixed In Key + DSP macro analysis (scripts/track_analysis.json), and
audio_manifest.json, emitting js/data.js with zero local filesystem paths.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path.home() / ".agents" / "skills" / "bill-music" / "assets"
STAGING_DIR = Path.home() / "tmp" / "music_map_staging"
OUT_JS = ROOT / "js" / "data.js"

PHASE_META = [
    ("phase0_archive", "Phase 0: Archive", "P0 Archive", "1997–2014", "Early DAWs & Archive"),
    ("phase1_early", "Phase 1: Early", "P1 Early", "2013–2018", "Live 8–10"),
    ("phase2_mid", "Phase 2: Mid", "P2 Mid", "2018–2022", "Live 10"),
    ("phase3_ambient", "Phase 3: Ambient", "P3 Ambient", "2020–2024", "Live 10→12"),
    ("phase4_recent", "Phase 4: Recent", "P4 Recent", "2024–2026", "Live 12"),
]

ARCHIVE_ERAS = [
    "present_early_97",
    "present_breaks_99",
    "present_med_house_01",
    "present_arcadian_03",
    "hd_2005",
    "bands_archive",
]

ERA_META = [
    ("present_early_97", "Early Roots", "Early '97", "1997–98", "phase0_archive", "P0", "Huskies & earliest raw ambient/downtempo experiments"),
    ("present_breaks_99", "Distorted Breaks", "Breaks '99", "1999–00", "phase0_archive", "P0", "Gritty breakbeat, big beat & distorted jungle-breaks"),
    ("present_med_house_01", "Meditative & House", "Med & House", "2001–02", "phase0_archive", "P0", "Edgeware Rd meditative pulse & Disco Queen house experiments"),
    ("present_arcadian_03", "Arcadian & 8-Bit", "Arcadian '03", "2003–04", "phase0_archive", "P0", "C64/video-game synth, Arcadian & 2004 PR3S3NT electro"),
    ("hd_2005", "2005 Hard Drive", "2005 HD", "2005–10", "phase0_archive", "P0", "Archival bounces & mixes"),
    ("bands_archive", "Archive 2006–14", "Arch 06", "2006–14", "phase0_archive", "P0", "Spudboy & 2006–14 solo archive"),
    ("archive_2013_18", "Archive 13–18", "Arch 13", "2013–18", "phase1_early", "P1", ""),
    ("nihon_forever", "Nihon Forever", "Nihon", "~2015–17", "phase1_early", "P1", ""),
    ("ep_concepts", "EP Concepts", "EP Conc", "~2016–18", "phase1_early", "P1", "Includes 'Le Garage ≤2018' folder"),
    ("le_garage", "Le Garage", "Garage", "2018–19", "phase2_mid", "P2", "Le Garage Hermétique (5/9 microtonal or gamelan)"),
    ("psychedailies", "Psychedailies", "Psych", "2019–21", "phase2_mid", "P2", "Made in one day, with help from friends on Endlesss."),
    ("archive_2018_23", "Archive 18–23", "Arch 18", "2018–23", "phase2_mid", "P2", "Audio-heavy archive"),
    ("spirit_guides", "Spirit Guides", "Spirit", "~2020–22", "phase3_ambient", "P3", ""),
    ("lucid_crystal", "Lucid Crystal", "Lucid", "~2021–23", "phase3_ambient", "P3", ""),
    ("remixes_commissions", "Remixes/Comm.", "Remix", "2020–24", "phase3_ambient", "P3", ""),
    ("sketches_2024_25", "2024–25", "24–25", "2024–25", "phase4_recent", "P4", "2024–25 studio working renders & sketches"),
    ("ecstatic_wave", "Ecstatic Wave", "Ecstatic", "2025", "phase4_recent", "P4", ""),
    ("sketches_2026", "2026", "2026", "2026", "phase4_recent", "P4", "2026 studio works & latest renders"),
]

# Ordered 1997–2004 stylistic & archival partition (anchor tracks placed at slot 1 for Timeline Animator)
PRESENT_1997_2004_ORDERED_TRACKS: dict[str, tuple[int, list[str]]] = {
    "present_early_97": (1998, [
        "present_electro_41",  # Huskies Ultra (explicit 1997–98 anchor)
        "present_ambient_1",   # 1 Thing Led 2 Another
        "present_ambient_2",   # Sankhara 01
        "present_ambient_9",   # Trying
        "present_electro_65",  # You Just Know
        "present_electro_38",  # Having a Fake
        "present_electro_55",  # Raymonds Rebirthing in the Rotating Restuarant
        "present_electro_48",  # New Beginnings 4 Veronica + Vernice
        "present_electro_31",  # Compassion
        "present_electro_59",  # The Importance of Having Compassion for Humans
        "present_electro_36",  # Finding Your Sincerity Whilst Travelling
        "present_electro_35",  # Finding your..Pt 4
        "present_electro_42",  # I Never Knew Why ... (brick Lane)
    ]),
    "present_breaks_99": (2000, [
        "present_electro_20",  # Rock the Discotek
        "present_electro_63",  # Turbocat
        "present_electro_40",  # Horus and the
        "present_electro_49",  # No Need 2 Worry
        "present_electro_43",  # Jesus Walking
        "present_electro_21",  # Ruffneck
        "present_electro_61",  # Tripping
        "present_electro_62",  # tripping with Raymond and Stanley at cheese and wine parties
        "present_electro_24",  # Thankyou
        "present_electro_15",  # Jump Up Cru
        "present_electro_22",  # Shake It
        "present_electro_2",   # UFO (People U Can Relax With)
        "present_ambient_5",   # Having a Fake Little Smile Even When You're on Your Own
        "present_electro_54",  # 02 Present - Heron - Track 2
        "present_electro_32",  # 4 D
        "present_electro_37",  # Getting Emotional Over Small Things
        "present_electro_26",  # Vocalcore
        "present_electro_16",  # Kitchen Song #2
        "present_electro_47",  # Ruff Neck (sketch)
    ]),
    "present_med_house_01": (2001, [
        "present_ambient_7",   # Edgeware Rd (explicit meditative anchor)
        "present_electro_11",  # Disco Queen Human Version (explicit Disco Queen house anchor)
        "present_ambient_4",   # Do It Like a Robot
        "present_ambient_3",   # Saying Only Small Things
        "present_electro_1",   # Disco Queen (C64)
        "present_electro_10",  # Disco Queen C64 Version
        "present_ambient_8",   # Plodding
        "present_ambient_6",   # Buick
        "present_ambient_10",  # Ultra Fx2
        "present_electro_30",  # Caribbean Hotel At Night ... (le Garcon)
        "present_electro_8",   # Collaboration
        "present_electro_23",  # Spiritual Quest
        "present_electro_34",  # Fatter Than U
        "present_electro_27",  # We Can Go Dao
        "present_electro_39",  # Horus
        "present_electro_56",  # Space Bandits
        "present_electro_29",  # Buick Beats (sketch)
    ]),
    "present_arcadian_03": (2003, [
        "present_electro_6",   # Arcadian (explicit video-game/Arcadian anchor)
        "present_electro_19",  # Robotron
        "present_electro_64",  # Yellow
        "present_electro_12",  # I Don't Believe in Myself
        "present_electro_46",  # Nameless (--new2004)
        "present_electro_4",   # Lime Angel Delight (--new2004)
        "present_electro_17",  # Pitstop II
        "present_electro_9",   # Computer Ryhmes
        "present_electro_18",  # Pork Gelatin
        "present_electro_14",  # Ichi Ban
        "present_electro_3",   # Bethnal Green Sunset
        "present_electro_13",  # I Want 2 Rock Out
        "present_electro_25",  # Ultra Fx
        "present_electro_51",  # pr3s3nt - Grimy (lossy MP3 fallback if present)
        "hd_2005_23",          # pr3s3nt - Grimy (lossless ALAC master)
        "present_electro_53",  # pr3s3nt - WAR hard mix (lossy MP3 fallback if present)
        "hd_2005_48",          # pr3s3nt - WAR hard mix (lossless ALAC master)
        "present_electro_60",  # The Pills
        "present_electro_28",  # 1st Idea (sketch)
    ]),
}

PRESENT_1997_2004_ERA_MAP: dict[str, tuple[str, int, int]] = {}
for _era_id, (_era_yr, _tids) in PRESENT_1997_2004_ORDERED_TRACKS.items():
    for _slot_idx, _tid in enumerate(_tids, start=1):
        _yr = 1997 if _tid == "present_electro_41" else (2004 if _tid in {"present_electro_4", "present_electro_46", "present_electro_51", "hd_2005_23", "present_electro_53", "hd_2005_48", "present_electro_60"} else _era_yr)
        PRESENT_1997_2004_ERA_MAP[_tid] = (_era_id, _yr, _slot_idx)


def resolve_present_1997_2004_era(tid: str, cur_era: str, cur_year: int | None, cur_slot: int | None = None) -> tuple[str, int, int]:
    if tid in PRESENT_1997_2004_ERA_MAP:
        return PRESENT_1997_2004_ERA_MAP[tid]
    if cur_era == "present_ambient":
        return "present_med_house_01", 2001, int(cur_slot or 99)
    if cur_era == "present_electro":
        return "present_arcadian_03", 2003, int(cur_slot or 99)
    return cur_era, int(cur_year or 2016), int(cur_slot or 0)

FORCE_NON_SKETCH_IDS = {
    "archive_2013_18_10",   # A Aeolian Piano Sketch
    "archive_2013_18_11",   # Demo A raw (latest Demo A)
    "archive_2013_18_19",   # Audiorealism test
    "archive_2013_18_20",   # demo B
    "archive_2013_18_21",   # Baddass Arp (sketch)
    "archive_2013_18_59",   # G sharp piano sketch
    "archive_2013_18_61",   # Gamelan Test
    "archive_2013_18_89",   # Logic house loops
    "archive_2013_18_116",  # Polyplex Test
    "archive_2013_18_117",  # Polyplex Test 02 No Reaktor
    "archive_2013_18_155",  # Winter Mood
    "archive_2018_23_58",   # RC505 1st test
    "bands_archive_18",     # Mic Test2 Rev
    "ecstatic_wave_14",     # Lyrical
    "ep_concepts_8",        # 7rez
    "ep_concepts_14",       # Brick lane
    "ep_concepts_15",       # Dubdrop
    "ep_concepts_35",       # Quantore
    "hd_2005_46",           # Swing Demo
    "present_electro_28",   # 1st Idea
    "present_electro_46",   # Nameless
    "sketches_2024_25_4",   # Techno Idea
    "sketches_2026_10",     # Domi loops
}
FORCE_SKETCH_IDS = {
    "archive_2013_18_12",   # Afrique (post-024281: sketch despite >= 75s)
    "archive_2013_18_15",   # Anjuna (post-023995: sketch despite >= 75s)
    "archive_2013_18_33",   # Chord-ideas (post-024281: sketch despite >= 75s)
    "archive_2013_18_35",   # Clean 29 Test Track (post-024108: sketch despite >= 75s)
    "archive_2013_18_70",   # Hip-hawp B (post-024500: sketch despite >= 75s)
    "archive_2013_18_71",   # Huge-riff Demo (post-024281: sketch despite >= 75s)
    "archive_2013_18_87",   # Lazer-sketch (post-024096: sketch despite >= 75s)
    "archive_2013_18_97",   # Massive Dune Patch (post-023356: sketch despite >= 75s)
    "archive_2013_18_114",  # Paradise Kit Test (post-024281: sketch despite >= 75s)
    "archive_2013_18_122",  # Reese Rumble (post-024088: sketch despite >= 75s)
    "archive_2013_18_123",  # Rez Tweak (post-024281: sketch despite >= 75s)
    "archive_2013_18_127",  # Rock Sketch (post-024281: sketch despite >= 75s)
    "archive_2013_18_132",  # Scrapeyard Sketch (post-024281: sketch despite >= 75s)
    "archive_2013_18_137",  # Spiral Structure (post-024111: sketch despite >= 75s; became Kita Narashino)
    "archive_2013_18_139",  # Step 411 Regal Sketch (post-024281: sketch despite >= 75s)
    "archive_2013_18_142",  # Synth Test Imposcar- Devastor (post-024281: sketch despite >= 75s)
    "archive_2013_18_148",  # Tryell modsynth (post-024126: sketch despite >= 75s)
    "archive_2013_18_149",  # Tryell modsynth2 (post-024281: sketch despite >= 75s)
    "archive_2013_18_152",  # Weather-reportish (post-024109: sketch despite >= 75s)
    "archive_2013_18_154",  # Who-knows 01 Blues7th (post-024110: sketch despite >= 75s)
    "archive_2018_23_48",   # Gnarly Peak Beat (post-024281: sketch despite >= 75s)
    "bands_archive_5",      # Spudboy — Drone 2 Static (post-024510: sketch despite >= 75s)
    "bands_archive_8",      # Dancehorl ruff (post-024281: sketch despite >= 75s)
    "bands_archive_15",     # Lets Watch TV Ruff (post-024281: sketch despite >= 75s)
    "ep_concepts_37",       # Random Acid Hard (post-024281: sketch despite >= 75s)
    "hd_2005_16",           # Deep ruff (post-024281: sketch despite >= 75s)
    "hd_2005_31",           # NewX sketch (post-024281: sketch despite >= 75s)
    "hd_2005_49",           # Will U Wont U Ruff (post-024281: sketch despite >= 75s)
    "present_electro_25",   # Ultra Fx (post-024281: sketch despite >= 75s)
    "sketches_2024_25_24",  # Granular Perc Fun Gamelanish (post-023452: sketch despite >= 75s)
    "sketches_2026_3",      # Mya Moody Banger (post-023995: sketch despite >= 75s)
    "sketches_2026_19",     # piano quant sketch in F (post-024281: sketch despite >= 75s)
}
FORCE_SKETCH_TITLES = {
    "afrique",
    "anjuna",
    "chord-ideas",
    "clean 29 test track",
    "dancehorl ruff",
    "deep ruff",
    "gnarly peak beat",
    "hip-hawp b",
    "hip-hawp b 1",
    "huge-riff demo",
    "lazer-sketch",
    "lazer sketch",
    "lets watch tv ruff",
    "massive dune patch",
    "newx sketch",
    "paradise kit test",
    "piano quant sketch in f",
    "granular perc fun",
    "granular perc fun gamelanish",
    "granular perc (gamelanish)",
    "mya moody banger",
    "random acid hard",
    "reese rumble",
    "rez tweak",
    "rock sketch",
    "scrapeyard sketch",
    "spiral structure",
    "spudboy — drone 2 static",
    "spudboy - drone 2 static",
    "step 411 regal sketch",
    "synth test imposcar- devastor",
    "tryell modsynth",
    "tyrell modsynth",
    "tryell modsynth2",
    "tyrell modsynth2",
    "ultra fx",
    "weather-reportish",
    "who-knows 01 blues7th",
    "will u wont u ruff",
}
TRACK_NOTES = {
    "archive_2013_18_137": "Early sketch that became Kita Narashino.",
}
CURATED_FREE_DOWNLOAD_OVERRIDES = {
    "remixes_commissions_17": {
        "tier": "free_download",
        "dl_ready": True,
        "mp3_320_url": "https://github.com/BillTribble/music-map/releases/download/archive-downloads-v1/Bill_Tribble_-_Voidcomplet_Ripple_effect_Bill_Tribble_vox.mp3",
        "mp3_320_bytes": 7123317,
        "mp3_size_mb": 6.8,
    },
}
DROP_PREVIEW_OVERRIDES = {
    "archive_2018_23_62": {  # Spectacular fail (post-024518: ~30s RC-505 pre-drop build -> 44.25s sub-bass drop)
        "has_drop": True,
        "drop_sec": 44.25,
        "preview_start_sec": 30.0,
        "preview_dur_sec": 24.48,
        "duration_sec": 24.48,
        "bytes": 343913,
    },
    "psychedailies_26": {  # '24' (post-024497 + post-024689: exact 125.00 BPM 4/4, all Psychedailies start previews at 0.0s)
        "has_drop": True,
        "drop_sec": 15.36,
        "preview_start_sec": 0.0,
        "preview_dur_sec": 17.28,
    },
}

# Ground-truth DAW / acoustically verified BPM overrides (post-024497, task-1061).
BPM_OVERRIDES: dict[str, float] = {
    "psychedailies_26": 125.0,     # '24' — Ableton 24.als <Tempo Manual="125">, 4/4, 96 beats = 46.08s
    "ai_music_123_fc0278": 100.0,  # 'Scary moombah muertos' — 100 BPM moombahton (was 198.77 ceiling lag)
    "ai_music_190_26d13e": 112.35, # 'Spiro Vapourer disguised (Cover)' — 112.35 BPM (was halved to 56.17)
    "archive_2018_23_42": 98.66,   # 'FF33b 02 bass cut' — 98.66 BPM (was 198.77 ceiling lag)
    "present_ambient_7": 95.05,    # 'Edgeware Rd' — 95.05 BPM (was 198.77 ceiling lag)
}


def load_beatgrids_map(beatgrids_js: Path | None = None) -> dict[str, dict]:
    bg_path = beatgrids_js or (ROOT / "js" / "beatgrids.js")
    if not bg_path.exists():
        return {}
    try:
        raw = bg_path.read_text(encoding="utf-8")
        idx = raw.index("{")
        return json.loads(raw[idx:].rstrip(";\n "))
    except Exception:
        return {}


def apply_canonical_bpm_override(t: dict, beatgrids_map: dict[str, dict]) -> None:
    tid = str(t.get("id") or "")
    if t.get("is_spoken_word"):
        return
    target_bpm: float | None = None
    if tid in BPM_OVERRIDES:
        target_bpm = float(BPM_OVERRIDES[tid])
    else:
        g = beatgrids_map.get(tid)
        if isinstance(g, dict):
            gb = float(g.get("bpm") or 0.0)
            grv = str(g.get("groove") or "")
            bc = float(g.get("beat_clarity") or 0.0)
            cur_bpm = float(t.get("bpm") or 0.0)
            if grv in ("4x4", "broken") and 65.0 <= gb <= 185.0:
                target_bpm = gb
            elif grv == "ambient" and bc >= 0.75 and 75.0 <= gb <= 165.0 and (cur_bpm <= 65.0 or cur_bpm >= 185.0):
                target_bpm = gb
    if target_bpm is not None and target_bpm > 0:
        bpm_r = round(target_bpm, 2)
        t["bpm"] = bpm_r
        t["musical_bpm"] = bpm_r
        t["effective_bpm"] = bpm_r
        t["beat_sec"] = round(60.0 / bpm_r, 4)
        t["bar_sec"] = round(240.0 / bpm_r, 4)
    if tid == "psychedailies_26":
        t["groove_style"] = "four_on_floor"
        t["rhythm_tag"] = "Driven 4/4 house pulse"


def load_drop_previews_map(drop_json: Path | None = None) -> dict[str, dict]:
    dp = drop_json or (ROOT / "scripts" / "drop_previews.json")
    if not dp.exists():
        return {}
    try:
        obj = json.loads(dp.read_text(encoding="utf-8"))
        return dict(obj.get("tracks") or {}) if isinstance(obj, dict) else {}
    except Exception:
        return {}


def apply_canonical_preview_first_half(
    t: dict,
    drop_previews_map: dict[str, dict],
    beatgrids_map: dict[str, dict],
) -> None:
    tid = str(t.get("id") or "")
    era = str(t.get("era") or "").strip().lower()
    is_psy = era == "psychedailies" or tid.startswith("psychedailies_")
    is_ai = bool(t.get("is_ai"))
    g = beatgrids_map.get(tid) or {}
    full_dur = float(t.get("full_duration_sec") or t.get("duration_sec") or 0.0)
    aud_end = float(g.get("audible_end_sec") or full_dur)
    eff_end = min(full_dur, aud_end) if aud_end > 0 else full_dur
    if t.get("has_mush") and t.get("mush_onset_sec"):
        mush_lim = float(t["mush_onset_sec"]) + 3.0
        if 12.0 < mush_lim < eff_end:
            eff_end = mush_lim
    hard_max = 0.0
    if eff_end > 4.0 and full_dur > 4.0:
        cap = min(0.48 * eff_end, 0.48 * full_dur)
        if eff_end >= 60.0:
            cap = min(cap, eff_end - 25.0)
        elif eff_end >= 32.0:
            cap = min(cap, eff_end - 16.0)
        else:
            cap = min(cap, eff_end * 0.40)
        hard_max = max(0.0, round(cap, 2))

    entry = DROP_PREVIEW_OVERRIDES.get(tid) or drop_previews_map.get(tid)
    if isinstance(entry, dict) and entry.get("has_drop"):
        cand = 0.0 if is_psy else round(float(entry["preview_start_sec"]), 2)
        if cand <= hard_max + 1e-6:
            t["has_drop"] = True
            t["drop_sec"] = round(float(entry["drop_sec"]), 2)
            t["preview_start_sec"] = cand
            t["preview_dur_sec"] = round(float(entry["preview_dur_sec"]), 2)
        else:
            t.pop("has_drop", None)
            t.pop("drop_sec", None)
            t["preview_start_sec"] = 0.0 if (is_psy or is_ai) else hard_max
    else:
        t.pop("has_drop", None)
        t.pop("drop_sec", None)
        if isinstance(entry, dict) and entry.get("reanchored_first_half"):
            t["preview_start_sec"] = 0.0 if (is_psy or is_ai) else round(min(hard_max, float(entry["preview_start_sec"])), 2)
            if entry.get("preview_dur_sec"):
                t["preview_dur_sec"] = round(float(entry["preview_dur_sec"]), 2)
        elif is_ai:
            t["preview_start_sec"] = 0.0

    if is_psy:
        t["preview_start_sec"] = 0.0
        t["cue_sec"] = 0.0
    else:
        if float(t.get("preview_start_sec") or 0.0) > hard_max + 1e-6:
            t["preview_start_sec"] = 0.0 if is_ai else hard_max
        t["cue_sec"] = 0.0


LOUDNESS_TARGET_LUFS = -10.0


def load_track_loudness_map(loudness_json: Path | None = None) -> dict[str, dict]:
    lp = loudness_json or (ROOT / "scripts" / "track_loudness.json")
    if not lp.exists():
        return {}
    try:
        obj = json.loads(lp.read_text(encoding="utf-8"))
        return dict(obj.get("tracks") or {}) if isinstance(obj, dict) else {}
    except Exception:
        return {}


def apply_canonical_loudness_override(t: dict, loudness_map: dict[str, dict]) -> None:
    tid = str(t.get("id") or "")
    ent = loudness_map.get(tid)
    if not isinstance(ent, dict) or ent.get("lufs") is None:
        return
    lufs_r = round(float(ent["lufs"]), 1)
    tp_r = round(float(ent.get("true_peak_db", -1.0)), 1)
    raw_db = max(-18.0, min(14.0, LOUDNESS_TARGET_LUFS - lufs_r))
    if raw_db > 0.0 and math.isfinite(tp_r):
        eff_tp = min(tp_r, 0.5)
        raw_db = min(raw_db, max(0.0, (-0.5 - eff_tp) + 6.5))
    gain_db = round(raw_db, 2)
    t["lufs"] = lufs_r
    t["true_peak_db"] = tp_r
    t["gain_db"] = gain_db
    t["gain_trim"] = round(math.pow(10.0, gain_db / 20.0), 4)

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
    # Owner track removals (post-023520, post-023524, post-023576, post-023651, post-023691, post-023696, post-023750, post-023978, post-024072, post-024081, post-024281)
    "present_electro_7",
    "hd_2005_42",
    "archive_2013_18_146",
    "archive_2013_18_9",
    "archive_2013_18_18",
    "archive_2013_18_34",
    "archive_2018_23_66",
    "archive_2013_18_37",
    "archive_2013_18_52",
    "archive_2013_18_73",
    "archive_2013_18_76",
    "archive_2013_18_77",
    "archive_2013_18_78",
    "archive_2013_18_103",
    "hd_2005_33",
    # Superseded pre-release archive versions of released tracks (post-024882) + Wireless removal (post-024902)
    "archive_2013_18_6",    # Casus Bella -> Sunrise on an alien shore (ep_concepts_39)
    "archive_2013_18_43",   # Deepspace Guitar -> Voice of the Spirits (spirit_guides_2)
    "archive_2013_18_106",  # Monks of Umber 03 Osx -> Dark Night of the Soul (spirit_guides_4)
    "archive_2013_18_141",  # Suspended -> Call to Adventure (spirit_guides_1)
    "sketches_2024_25_32",  # Wireless (feat. Sasha Jacques) — removed by owner (post-024902)
}

TITLE_OVERRIDES = {
    "hd_2005_10": "As we Enter",
    "present_electro_31": "The Importance of Having Compassion for Humans",
    "present_electro_61": "tripping with Raymond and Stanley at cheese and wine parties",
    "hd_2005_23": "Grimy",
    "hd_2005_48": "WAR hard mix",
    "archive_2013_18_53": "Epic Powers",
    "archive_2013_18_120": "Protocol X Jam 2017",
    "ecstatic_wave_1": "Flowing Wave (Preview)",
    "remixes_commissions_17": "Voidcomplet - Ripple effect (Bill Tribble vox)",
}
SHORT_TITLE_OVERRIDES: dict[str, str] = {}

STYLE_OVERRIDES: dict[str, dict] = {
    "archive_2013_18_31": {
        "cluster_id": "d10_dark_ambient",
        "cluster_label": "Dark & experimental ambient",
        "cluster_idx": 10,
        "discogs_styles": ["Dark Ambient", "Drone", "Experimental"],
        "discogs_top": "Dark Ambient",
        "mood_tags": ["Dark", "Soundscape"],
    },
    "hd_2005_2": {
        "cluster_id": "d10_dark_ambient",
        "cluster_label": "Dark & experimental ambient",
        "cluster_idx": 10,
        "discogs_styles": ["Experimental Ambient", "Dark Ambient", "Abstract"],
        "discogs_top": "Experimental Ambient",
        "mood_tags": ["Dark", "Meditative"],
        "instrument_tags": ["Electric Guitar", "Guitar", "Synthesizer"],
    },
    "spirit_guides_4": {
        "cluster_id": "d0_ambient",
        "cluster_label": "Ambient & soundscapes",
        "cluster_idx": 0,
        "discogs_styles": ["Ambient", "Berlin-School", "New Age"],
        "discogs_top": "Ambient",
        "mood_tags": ["Soundscape", "Meditative"],
    },
    "present_electro_30": {
        "cluster_id": "d2_downtempo",
        "cluster_label": "Downtempo & leftfield",
        "cluster_idx": 2,
        "discogs_styles": ["Downtempo", "Leftfield", "Lounge"],
        "discogs_top": "Downtempo",
        "mood_tags": ["Whimsical", "Playful"],
    },
}

_PRESENT_LEET_MAP = str.maketrans({
    "3": "e", "0": "o", "1": "i", "4": "a", "5": "s", "7": "t", "z": "s",
})
_PRESENT_PROTECTED_WORDS = {
    "crescent", "crescents", "omnipresent", "percent", "percents",
    "precept", "precepts", "preen", "preens", "prefect", "prefects",
    "preheat", "preheats", "prescient", "presence", "presences",
    "preset", "presets", "president", "presidents", "pretend", "pretends",
    "pretext", "pretexts", "prevent", "prevents", "prudent", "recent",
    "regent", "regents", "relent", "relents", "repent", "repents",
    "represent", "represents", "resend", "resent", "resents", "reset", "resets",
}
_PRESENT_EXACT_NORMS = {
    "present", "presents", "presnt", "presnet", "prsent", "prezent",
    "presant", "presen", "prsnt", "pesent", "prznt",
}
_COMPOUND_PRESENT_SUFFIX_RE = re.compile(
    r"^([A-Za-z0-9]{5,10}?)(mix\d*|remix\d*|edit\d*|dub\d*|vip\d*|ver\d*)$",
    re.IGNORECASE,
)


def _damerau_levenshtein(a: str, b: str) -> int:
    la, lb = len(a), len(b)
    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + cost,
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[la][lb]


def is_present_token(tok: str) -> bool:
    """Return True if `tok` is 'present'/'presents' under any spelling, typo (Damerau-Levenshtein <= 2),
    or leetspeak variant (e.g. 'pr3s3nt', 'Pr3s3nT', 'presnt', 'presnet', 'prsent', 'prezent', 'presant'),
    while protecting genuine English words like 'Represent', 'Omnipresent', 'Preset', or 'Reset'."""
    raw = re.sub(r"[^A-Za-z0-9]", "", tok or "")
    if len(raw) < 5 or len(raw) > 10:
        return False
    raw_low = raw.lower()
    if raw_low in _PRESENT_PROTECTED_WORDS:
        return False
    norm = raw_low.translate(_PRESENT_LEET_MAP)
    if norm in _PRESENT_PROTECTED_WORDS:
        return False
    if norm in _PRESENT_EXACT_NORMS:
        return True
    if not norm.startswith(("pr", "pe")):
        return False
    return min(_damerau_levenshtein(norm, "present"), _damerau_levenshtein(norm, "presents")) <= 2


def strip_present_references(title: str) -> str:
    """Remove all references to the 'Present' / 'pr3s3nt' alias (any spelling, typo, leetspeak, or
    compound like 'Pr3s3nTmix') and clean up any leftover separators while never returning empty."""
    orig = re.sub(r"\s+", " ", str(title or "")).strip()
    if not orig:
        return orig
    s = orig

    def _clean_group(m: re.Match) -> str:
        open_b, inner, close_b = m.group(1), m.group(2).strip(), m.group(3)
        cleaned_inner = strip_present_references(inner)
        if not cleaned_inner or cleaned_inner.lower() == "bill":
            return ""
        return f"{open_b}{cleaned_inner}{close_b}"

    s = re.sub(r"([(\[])([^\)\]]+)([)\]])", _clean_group, s)

    stripped_lead = False
    m_lead_bill = re.match(r"^bill\s+([A-Za-z0-9]+)(?:\s*[-_–—:]+\s*|\s+)(.+)$", s, re.IGNORECASE)
    if m_lead_bill and is_present_token(m_lead_bill.group(1)):
        s = m_lead_bill.group(2).strip()
        stripped_lead = True

    parts = re.split(r"(\s+|[-_–—]+)", s)
    non_sep_idx = [idx for idx, p in enumerate(parts) if p and not re.fullmatch(r"\s+|[-_–—]+", p)]
    first_word_idx = non_sep_idx[0] if non_sep_idx else -1
    out_parts = []
    for idx, p in enumerate(parts):
        if not p or re.fullmatch(r"\s+|[-_–—]+", p):
            out_parts.append(p)
            continue
        if is_present_token(p):
            if idx == first_word_idx:
                stripped_lead = True
            continue
        m_comp = _COMPOUND_PRESENT_SUFFIX_RE.match(p)
        if m_comp and is_present_token(m_comp.group(1)):
            out_parts.append(m_comp.group(2))
            continue
        out_parts.append(p)

    s = "".join(out_parts)
    s = re.sub(r"^(?:\s*[-_–—:]+\s*)+", "", s)
    s = re.sub(r"(?:\s*[-_–—:]+\s*)+$", "", s)
    s = re.sub(r"(\s*[-_–—]+\s*){2,}", " - ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if re.fullmatch(r"\([^()]+\)|\[[^\[\]]+\]", s) and not re.fullmatch(r"\([^()]+\)|\[[^\[\]]+\]", orig):
        s = s[1:-1].strip()
    if stripped_lead and s and s[0].islower():
        s = s[0].upper() + s[1:]
    return s if s else orig

_TITLE_SEMANTIC_PREV_WORDS = {
    "part", "pt", "pt.", "vol", "vol.", "volume", "phase", "season", "act", "chapter", "no", "no.",
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}
_TITLE_PROTECTED_NUMS = {"303", "606", "707", "808", "909"}


def clean_track_title(raw_title: str) -> str:
    """Strip leading track/index numbers (e.g. '01 ', '04 ', '12 - ') and trailing DAW bounce/master/take
    suffixes (e.g. ' 07', ' Master', ' Final Comp', ' (1)') while protecting genuine semantic titles
    like '1 Thing Led 2 Another', '1st Idea', '4 D', 'Counterpoint-part-2', '808 Bomb', 'Nov 25', and years."""
    s = re.sub(r"\s+", " ", str(raw_title or "")).strip()
    if not s or re.fullmatch(r"\d+", s):
        return s

    stripped_prefix = False
    if not re.match(
        r"^(?:1\s+thing\b|\d+(?:st|nd|rd|th)\b|(?:303|606|707|808|909|19\d{2}|20\d{2})\b)",
        s,
        re.IGNORECASE,
    ):
        m_lead = re.match(r"^(\d{1,2})(?:\s*[-._)]+\s*|\s+)(.+)$", s)
        if m_lead:
            rem = m_lead.group(2).strip()
            if len(rem) >= 2 and not re.fullmatch(r"\d+", rem):
                s = rem
                stripped_prefix = True

    while True:
        prev = s
        m_par = re.match(r"^(.+?)(?:\s+|\s*[-_]\s*)(?:\(\d{1,3}\)|\[\d{1,3}\])$", s)
        if m_par and len(m_par.group(1).strip()) >= 2:
            s = m_par.group(1).strip()
            continue

        m_daw = re.match(
            r"^(.+?)(?:\s+|\s*[-_+]+\s*)(?:"
            r"\(?(?:final\s+master|master\s+20\d{2}|mastered|premaster(?:ed)?|unmastered|master|"
            r"final\s+comp|comp|level\s*match|level|main\s+out)\)?|"
            r"\(\d{2,3}(?:\.\d{1,2})?\s*bpm\)|"
            r"bounce(?:\s*[-_]?\s*\d+)?|"
            r"track\s+\d+|"
            r"v\d+[a-z]?|ver\.?\s*\d+|#\d+|"
            r"\d{2,3}\.\d{1,2}"
            r")$",
            s,
            re.IGNORECASE,
        )
        if m_daw and len(m_daw.group(1).strip()) >= 2:
            s = m_daw.group(1).strip()
            continue

        m_m1 = re.match(r"^(.+?\b\d{1,2})\s+M\d$", s)
        if m_m1 and len(m_m1.group(1).strip()) >= 2:
            s = m_m1.group(1).strip()
            continue

        if not re.search(r"\b[34567]\s*-\s*[48]$", s):
            m_num = re.match(r"^(.+?)(?:\s+|\s*[-_]\s*)(\d{1,5})$", s)
            if m_num:
                base = m_num.group(1).strip()
                num = m_num.group(2)
                is_year = bool(re.fullmatch(r"(?:19|20)\d{2}", num))
                tokens = [tok for tok in re.split(r"[\s\-_]+", base) if tok]
                last_word = tokens[-1].lower().rstrip(".,:") if tokens else ""
                is_chroma_007 = (num == "007" and last_word == "chroma")
                if (
                    len(base) >= 2
                    and not re.fullmatch(r"\d+", base)
                    and not is_year
                    and num not in _TITLE_PROTECTED_NUMS
                    and not is_chroma_007
                    and last_word not in _TITLE_SEMANTIC_PREV_WORDS
                ):
                    s = base
                    continue

        s = re.sub(r"[\s\-_–—]+$", "", s).strip()
        if s == prev:
            break

    if stripped_prefix and s and s[0].islower():
        s = s[0].upper() + s[1:]
    return strip_present_references(s)

PRIVATE_TRACK_KEYS = (
    "local_path",
    "rel_path",
    "slug",
    "source_codec",
    "raw_drum_complexity",
    "raw_four_on_floor",
    "raw_breakbeat_score",
    "genre_scores",
)


def is_excluded_by_folder_rule(path_str: str) -> bool:
    if not path_str:
        return False
    low_p = path_str.lower()
    if (
        "ai music sandbox" in low_p
        or "musicfx ai test" in low_p
        or "bill in china" in low_p
        or "blame it on the boogie" in low_p
        or "status quo 01 free" in low_p
        or "take you chords 02-sketch vox" in low_p
        or low_p.endswith("/arps test.mp3")
        or "chord-ideas (1)-- best" in low_p
        or "counterpoint-part-2" in low_p
        or low_p.endswith("/epic 4-4 demo.mp3")
        or "infinity & beyond" in low_p
        or "jamstik" in low_p
        or "jamstick" in low_p
        or "minor chord rave riff" in low_p
        or "not 2 l8" in low_p
        or "war machine/war machine 04" in low_p
        or "demo a 00008 lyric" in low_p
        or "demo a 00007" in low_p
        or "monks of umber 03 osx" in low_p
        or "casus bella project/casus bella 03 master" in low_p
        or "stepper sketches 2012-2018/deepspace guitar." in low_p
        or "stepper sketches 2012-2018/suspended." in low_p
        or "wireless-bounce-1" in low_p
        or "push for ed uk/samples/wireless-1" in low_p
    ):
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
    cat_path = STAGING_DIR / "catalog_587_enriched.json"
    if cat_path.exists():
        cat_obj = json.loads(cat_path.read_text(encoding="utf-8"))
        for ct in cat_obj.get("tracks", []):
            if isinstance(ct, dict) and ct.get("id") and is_excluded_by_folder_rule(str(ct.get("local_path") or "")):
                out.add(str(ct["id"]))
    return out


def ensure_feat_vecs(tracks: list[dict]) -> None:
    """Ensure every track carries a standardized 8-float sonic feature vector `feat_vec` for WT-4 similarity walks."""
    if not tracks:
        return
    if all(isinstance(t.get("feat_vec"), list) and len(t["feat_vec"]) >= 6 for t in tracks):
        return
    weights = [1.55, 1.75, 1.45, 1.65, 1.65, 1.35, 1.25, 0.95]
    raw_cols: list[list[float]] = [[] for _ in range(8)]
    for t in tracks:
        vals = [
            float(t.get("energy", 5.0)),
            float(t.get("effective_bpm", t.get("musical_bpm", t.get("bpm", 110.0)))),
            float(t.get("drum_complexity", 35.0)),
            float(t.get("four_on_floor", 0.0)),
            float(t.get("breakbeat_score", 0.0)),
            float(t.get("mid_share", 0.2)),
            float(t.get("sub_share", 0.2)) + float(t.get("bass_share", 0.25)),
            float(t.get("harmonic_complexity", 50.0)),
        ]
        for ci, v in enumerate(vals):
            raw_cols[ci].append(v)

    means = [statistics.fmean(col) for col in raw_cols]
    stds = [statistics.pstdev(col) or 1.0 for col in raw_cols]
    for idx, t in enumerate(tracks):
        t["feat_vec"] = [
            round(((raw_cols[ci][idx] - means[ci]) / stds[ci]) * weights[ci], 3)
            for ci in range(8)
        ]


def backfill_track_near(tracks: list[dict], raw_near: dict) -> dict[str, list[list]]:
    """Filter excluded IDs out of track_near and guarantee 4 valid sonic neighbors per track."""
    valid_ids = {t["id"] for t in tracks}
    vec_by_id = {t["id"]: t["feat_vec"] for t in tracks}
    cluster_by_id = {t["id"]: t.get("cluster_id") for t in tracks}

    def _dist(a_id: str, b_id: str) -> float:
        va, vb = vec_by_id[a_id], vec_by_id[b_id]
        d = math.sqrt(sum((x - y) * (x - y) for x, y in zip(va, vb)))
        if cluster_by_id.get(a_id) and cluster_by_id.get(a_id) == cluster_by_id.get(b_id):
            d *= 0.86
        return d

    cleaned: dict[str, list[list]] = {}
    for t in tracks:
        tid = t["id"]
        kept = [
            [nid, float(sim)]
            for nid, sim in (raw_near.get(tid) or [])
            if nid in valid_ids and nid != tid
        ]
        if len(kept) < 4 and len(tracks) > 1:
            already = {nid for nid, _ in kept} | {tid}
            cands = sorted((oid for oid in valid_ids if oid not in already), key=lambda oid: _dist(tid, oid))
            for oid in cands[: 4 - len(kept)]:
                d = _dist(tid, oid)
                kept.append([oid, round(math.exp(-d / 3.2), 3)])
        cleaned[tid] = kept[:4]
    return cleaned


def resolve_default_analysis_path() -> Path:
    for cand in (
        STAGING_DIR / "analyzed_latest.json",
        STAGING_DIR / "analyzed_559.json",
        ROOT / "scripts" / "track_analysis.json",
    ):
        if cand.exists():
            return cand
    return ROOT / "scripts" / "track_analysis.json"


def build_from_full_analysis(
    analysis_path: Path,
    base_data_js: Path,
    exclusions_path: Path | None,
    archive_dl_path: Path | None,
    waveforms_path: Path | None,
    out_js_path: Path,
) -> None:
    """Self-contained full-corpus builder joining analysis, exclusions, archive DL sizes, and 160-bar waveforms/cues."""
    an_payload = json.loads(analysis_path.read_text(encoding="utf-8"))
    base_payload: dict = {}
    if base_data_js.exists():
        raw_js = base_data_js.read_text(encoding="utf-8")
        if "window.CORPUS_DATA = " in raw_js:
            base_payload = json.loads(raw_js.split("window.CORPUS_DATA = ", 1)[1].rstrip().rstrip(";"))

    excluded_ids = load_excluded_ids(exclusions_path)
    beatgrids_by_id = load_beatgrids_map()
    drop_previews_by_id = load_drop_previews_map()
    loudness_by_id = load_track_loudness_map()
    archive_dl = (
        json.loads(archive_dl_path.read_text(encoding="utf-8"))
        if archive_dl_path and archive_dl_path.exists()
        else {}
    )
    waveforms = (
        json.loads(waveforms_path.read_text(encoding="utf-8"))
        if waveforms_path and waveforms_path.exists()
        else {}
    )
    if isinstance(waveforms, dict) and "tracks" in waveforms and isinstance(waveforms["tracks"], dict):
        waveforms = waveforms["tracks"]

    base_track_by_id = {t["id"]: t for t in base_payload.get("tracks", [])}
    era_order_map = {e[0]: idx for idx, e in enumerate(ERA_META)}

    merged_tracks: list[dict] = []
    tracks_by_era: dict[str, list[dict]] = defaultdict(list)

    raw_tracks = an_payload.get("tracks", [])
    for src_t in raw_tracks:
        tid = src_t["id"]
        if tid in excluded_ids:
            continue
        t = dict(base_track_by_id.get(tid, {}))
        t.update(src_t)
        if tid in TITLE_OVERRIDES:
            t["title"] = strip_present_references(TITLE_OVERRIDES[tid])
        else:
            t["title"] = clean_track_title(str(t.get("title") or ""))
        t["shortTitle"] = SHORT_TITLE_OVERRIDES.get(
            tid,
            t["title"].split(" (")[0][:26]
            if " (" in t["title"] and len(t["title"]) > 26
            else t["title"][:26],
        )

        # Merge Tier B 320k MP3 / lossless FLAC download metadata when available
        dl_entry = archive_dl.get(tid) if isinstance(archive_dl, dict) else None
        if isinstance(dl_entry, dict) and t.get("tier") in ("archive_dl", "free_download"):
            for dk in ("mp3_320_url", "mp3_url", "mp3_320_bytes", "mp3_size_mb", "mp3_mb", "mp3_kbps", "has_lossless", "flac_url", "flac_bytes", "flac_size_mb", "flac_mb", "dl_ready"):
                if dk in dl_entry and dl_entry[dk] not in (None, ""):
                    t[dk] = dl_entry[dk]

        # Merge precomputed 160-bar SoundCloud waveform peaks, snippet cues, and stream URLs
        wf_entry = waveforms.get(tid) if isinstance(waveforms, dict) else None
        if isinstance(wf_entry, dict):
            if isinstance(wf_entry.get("peaks"), list) and wf_entry["peaks"]:
                t["peaks"] = [max(0, min(100, int(round(float(v))))) for v in wf_entry["peaks"]]
            if wf_entry.get("preview_start_sec") is not None:
                t["preview_start_sec"] = round(max(0.0, float(wf_entry["preview_start_sec"])), 2)
            if wf_entry.get("preview_dur_sec") is not None:
                t["preview_dur_sec"] = round(max(0.5, float(wf_entry["preview_dur_sec"])), 2)
            if wf_entry.get("full_duration_sec") is not None and float(wf_entry["full_duration_sec"]) > 0:
                t["full_duration_sec"] = round(float(wf_entry["full_duration_sec"]), 2)
            if wf_entry.get("stream_url"):
                t["stream_url"] = str(wf_entry["stream_url"])
            if wf_entry.get("youtube_id"):
                t["youtube_id"] = str(wf_entry["youtube_id"])

        for pk in PRIVATE_TRACK_KEYS:
            t.pop(pk, None)

        if t.get("is_ai"):
            t["preview_start_sec"] = 0.0
            t["cue_sec"] = 0.0
        else:
            new_era, new_yr, new_slot = resolve_present_1997_2004_era(
                str(t["id"]), str(t.get("era") or ""), t.get("year"), t.get("slot")
            )
            if new_era != t.get("era") or str(t["id"]) in PRESENT_1997_2004_ERA_MAP:
                t["era"] = new_era
                t["year"] = new_yr
                t["slot"] = new_slot
            is_psy = str(t.get("era") or "").strip().lower() == "psychedailies" or str(t.get("id") or "").startswith("psychedailies_")
            if is_psy:
                t["is_sketch"] = False
                t["note"] = "Made in one day, with help from friends on Endlesss."
            else:
                if str(t.get("id") or "") in TRACK_NOTES:
                    t["note"] = TRACK_NOTES[str(t["id"])]
                if str(t.get("id") or "") in FORCE_SKETCH_IDS or str(t.get("title") or "").strip().lower() in FORCE_SKETCH_TITLES:
                    t["is_sketch"] = True
                    t["wip_eligible"] = False
            if tid in DROP_PREVIEW_OVERRIDES:
                t.update(DROP_PREVIEW_OVERRIDES[tid])
            if is_psy:
                # Start all Psychedailies previews at 0:00 (post-024689)
                t["preview_start_sec"] = 0.0
                t["cue_sec"] = 0.0
            if tid in STYLE_OVERRIDES:
                for ov_k, ov_v in STYLE_OVERRIDES[tid].items():
                    t[ov_k] = list(ov_v) if isinstance(ov_v, list) else ov_v

        apply_canonical_bpm_override(t, beatgrids_by_id)
        apply_canonical_preview_first_half(t, drop_previews_by_id, beatgrids_by_id)
        apply_canonical_loudness_override(t, loudness_by_id)
        merged_tracks.append(t)

    merged_tracks.sort(key=lambda t: (era_order_map.get(t["era"], 99), int(t.get("slot", 0)), t["id"]))
    ensure_feat_vecs(merged_tracks)

    for t in merged_tracks:
        tracks_by_era[t["era"]].append(t)

    valid_ids = {t["id"] for t in merged_tracks}
    an_meta = an_payload.get("meta", {})
    base_meta = base_payload.get("meta", {})

    # Clean style_groups, track_map, and track_near against excluded_ids
    raw_groups = an_meta.get("style_groups") or base_meta.get("style_groups") or []
    style_groups = []
    for g in raw_groups:
        members = [mid for mid in g.get("members", []) if mid in valid_ids]
        if members:
            g_out = dict(g)
            g_out["members"] = members
            style_groups.append(g_out)

    raw_map = an_meta.get("track_map") or base_meta.get("track_map") or {}
    track_map = {tid: coords for tid, coords in raw_map.items() if tid in valid_ids}

    raw_near = an_meta.get("track_near") or base_meta.get("track_near") or {}
    track_near = backfill_track_near(merged_tracks, raw_near)

    era_anchors = an_meta.get("era_anchors") or base_meta.get("era_anchors") or []

    # Rebuild eras & phases preserving rich MIDI/audio distributions while updating track lists & macro_harmony
    base_eras_by_id = {
        e["id"]: e
        for e in (base_payload.get("eras") or an_payload.get("eras") or [])
        if isinstance(e, dict) and "id" in e
    }
    eras_out: list[dict] = []
    phase_to_eras: dict[str, list[str]] = defaultdict(list)
    for ekey, elabel, eshort, eyears, ephase, ptag, enote in ERA_META:
        phase_to_eras[ephase].append(ekey)
        e_tracks = tracks_by_era.get(ekey, [])
        if ekey in ARCHIVE_ERAS or ekey not in base_eras_by_id:
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
        else:
            er_copy = dict(base_eras_by_id[ekey])
            er_copy["tracks"] = e_tracks
            er_copy["audio_files"] = max(int(er_copy.get("projects") or 0), len(e_tracks))
            er_copy["macro_harmony"] = compute_macro_harmony(e_tracks)
            bpms_e = sorted(float(x["bpm"]) for x in e_tracks if x.get("bpm"))
            if bpms_e:
                ne = len(bpms_e)
                er_copy["bpm_p25"] = round(bpms_e[max(0, int((ne - 1) * 0.25))], 1)
                er_copy["bpm_p50"] = round(statistics.median(bpms_e), 1)
                er_copy["bpm_p75"] = round(bpms_e[min(ne - 1, int((ne - 1) * 0.75))], 1)
            eras_out.append(er_copy)

    base_phases_by_id = {
        p["id"]: p
        for p in (base_payload.get("phases") or an_payload.get("phases") or [])
        if isinstance(p, dict) and "id" in p
    }
    phases_out: list[dict] = []
    for pkey, plabel, pshort, pyears, pdaw in PHASE_META:
        eras_list = list(ARCHIVE_ERAS) if pkey == "phase0_archive" else phase_to_eras[pkey]
        p_all_tracks = [t for e in eras_list for t in tracks_by_era.get(e, [])]
        p_rep_tracks = []
        for idx_e, e in enumerate(eras_list):
            for rep_t in tracks_by_era.get(e, [])[:2]:
                t_rep = dict(rep_t)
                t_rep["slot"] = len(p_rep_tracks) + 1
                p_rep_tracks.append(t_rep)
        if pkey == "phase0_archive" or pkey not in base_phases_by_id:
            phases_out.append(
                extract_archive_item(
                    pkey,
                    plabel,
                    pshort,
                    pyears,
                    p_all_tracks,
                    extra={"daw": pdaw, "note": "Pre-2013 audio archive bounces" if pkey == "phase0_archive" else "", "tracks": p_rep_tracks},
                )
            )
        else:
            ph_copy = dict(base_phases_by_id[pkey])
            ph_copy["tracks"] = p_rep_tracks
            ph_copy["macro_harmony"] = compute_macro_harmony(p_all_tracks)
            phases_out.append(ph_copy)

    payload = {
        "meta": {
            "total_projects": base_meta.get("total_projects", 229),
            "total_midi_clips": base_meta.get("total_midi_clips", 1543),
            "total_pitched_audio_files": base_meta.get("total_pitched_audio_files", 448),
            "total_pitched_audio_notes": base_meta.get("total_pitched_audio_notes", 36761),
            "total_map_tracks": len(merged_tracks),
            "silhouette": an_meta.get("silhouette", base_meta.get("silhouette", 0.0)),
            "tuning_scales": base_meta.get("tuning_scales", TUNING_SCALES),
            "cof_order": COF_ORDER,
            "degree_labels": DEGREE_LABELS,
            "fine_harmony_keys": FINE_HARMONY_KEYS,
            "style_groups": style_groups,
            "era_anchors": era_anchors,
            "track_near": track_near,
            "track_map": track_map,
        },
        "tracks": merged_tracks,
        "phases": phases_out,
        "eras": eras_out,
    }

    out_js_path.parent.mkdir(parents=True, exist_ok=True)
    js_text = (
        "// Auto-generated corpus, archive, MIK energy, macro harmony & node map data.\n"
        f"window.CORPUS_DATA = {json.dumps(payload, separators=(',', ':'), ensure_ascii=False)};\n"
    )
    out_js_path.write_text(js_text, encoding="utf-8")
    n_peaks = sum(1 for t in merged_tracks if t.get("peaks"))
    n_cues = sum(1 for t in merged_tracks if t.get("preview_start_sec") is not None)
    print(
        f"Wrote {out_js_path} ({len(js_text):,} bytes, {len(merged_tracks)} tracks, "
        f"{len(style_groups)} clusters, {n_peaks} waveforms, {n_cues} cues)"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Build js/data.js from analyzed corpus, exclusions, and waveform cues.")
    ap.add_argument("--analysis-json", type=Path, default=None, help="Analyzed corpus JSON from analyze_corpus_map.py")
    ap.add_argument("--base-data-js", type=Path, default=ROOT / "js" / "data.js", help="Existing data.js for MIDI/audio distribution shells")
    ap.add_argument("--exclusions-json", type=Path, default=STAGING_DIR / "exclusions.json", help="Excluded track IDs JSON")
    ap.add_argument("--archive-dl-json", type=Path, default=STAGING_DIR / "archive_dl_results.json", help="Tier B 320k/FLAC download metadata")
    ap.add_argument("--waveforms-json", type=Path, default=STAGING_DIR / "waveforms_and_cues.json", help="160-bar peaks & snippet cues JSON")
    ap.add_argument("--out-js", type=Path, default=OUT_JS, help="Output JS file path (default: js/data.js)")
    ap.add_argument("--legacy-assets", action="store_true", help="Rebuild MIDI/audio distributions from ~/.agents/skills/bill-music/assets")
    args = ap.parse_args()

    analysis_path = args.analysis_json or resolve_default_analysis_path()
    if not args.legacy_assets or not (ASSETS_DIR / "style_distributions.json").exists():
        build_from_full_analysis(
            analysis_path=analysis_path,
            base_data_js=args.base_data_js,
            exclusions_path=args.exclusions_json,
            archive_dl_path=args.archive_dl_json,
            waveforms_path=args.waveforms_json,
            out_js_path=args.out_js,
        )
        return

    midi = json.loads((ASSETS_DIR / "style_distributions.json").read_text(encoding="utf-8"))
    audio = json.loads((ASSETS_DIR / "audio_style_distributions.json").read_text(encoding="utf-8"))
    phase_map = midi["metadata"]["phase_map"]

    manifest_path = ROOT / "scripts" / "audio_manifest.json"
    audio_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    raw_by_era = audio_manifest.get("tracks_by_era", {})

    ta = json.loads(analysis_path.read_text(encoding="utf-8")) if analysis_path.exists() else {}
    ta_by_id = {t["id"]: t for t in ta.get("tracks", [])}
    excluded_ids = load_excluded_ids(args.exclusions_json)
    beatgrids_by_id = load_beatgrids_map()
    drop_previews_by_id = load_drop_previews_map()
    loudness_by_id = load_track_loudness_map()

    merged_tracks: list[dict] = []
    tracks_by_era: dict[str, list[dict]] = defaultdict(list)
    era_order_list = [e[0] for e in ERA_META]
    for eid in era_order_list:
        for m_item in raw_by_era.get(eid, []):
            tid = m_item["id"]
            if tid in excluded_ids:
                continue
            a_item = ta_by_id.get(tid, {})
            merged = dict(a_item)
            merged.update(m_item)
            merged["era"] = eid
            for pk in PRIVATE_TRACK_KEYS:
                merged.pop(pk, None)
            if str(merged.get("id") or "") in FORCE_SKETCH_IDS or str(merged.get("title") or "").strip().lower() in FORCE_SKETCH_TITLES:
                merged["is_sketch"] = True
                merged["wip_eligible"] = False
            if tid in TRACK_NOTES:
                merged["note"] = TRACK_NOTES[tid]
            if tid in CURATED_FREE_DOWNLOAD_OVERRIDES:
                merged.update(CURATED_FREE_DOWNLOAD_OVERRIDES[tid])
            if tid in DROP_PREVIEW_OVERRIDES:
                merged.update(DROP_PREVIEW_OVERRIDES[tid])
            if eid == "psychedailies" or tid.startswith("psychedailies_"):
                merged["preview_start_sec"] = 0.0
                merged["cue_sec"] = 0.0
            if tid in STYLE_OVERRIDES:
                for ov_k, ov_v in STYLE_OVERRIDES[tid].items():
                    merged[ov_k] = list(ov_v) if isinstance(ov_v, list) else ov_v
            apply_canonical_bpm_override(merged, beatgrids_by_id)
            apply_canonical_preview_first_half(merged, drop_previews_by_id, beatgrids_by_id)
            apply_canonical_loudness_override(merged, loudness_by_id)
            merged_tracks.append(merged)
            tracks_by_era[eid].append(merged)

    ensure_feat_vecs(merged_tracks)

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
            "track_near": backfill_track_near(merged_tracks, ta.get("track_near", {})),
            "track_map": ta.get("track_map", {}),
        },
        "tracks": merged_tracks,
        "phases": phases_out,
        "eras": eras_out,
    }

    args.out_js.parent.mkdir(parents=True, exist_ok=True)
    js_text = (
        "// Auto-generated corpus, archive, MIK energy, macro harmony & node map data.\n"
        f"window.CORPUS_DATA = {json.dumps(payload, separators=(',', ':'), ensure_ascii=False)};\n"
    )
    args.out_js.write_text(js_text, encoding="utf-8")
    print(f"Wrote {args.out_js} ({len(js_text):,} bytes, {len(merged_tracks)} tracks, {len(eras_out)} eras, {len(phases_out)} phases)")


if __name__ == "__main__":
    main()

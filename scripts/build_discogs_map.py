#!/usr/bin/env python3
"""Build unified Folder-Prioritized Essentia Discogs-400 + Organic Continuum & AI Territory dataset (js/data.js)."""

import argparse
from collections import Counter
import json
import math
import os
import re
import sys

import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.manifold import MDS, TSNE
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler, normalize
import umap

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
  sys.path.insert(0, _SCRIPTS_DIR)
import build_data as bd  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_JS = os.path.join(_ROOT, "js", "data.js")
DEFAULT_FEATURES = "/tmp/music_map_discogs_features.npz"
DEFAULT_GENAI_BUNDLE = os.path.join(_ROOT, "scripts", "genai_catalog_198.json")
DEFAULT_YON_BUNDLE = os.path.join(_ROOT, "scripts", "yon_recovered_track.json")
DEFAULT_MASTERS_2026_BUNDLE = os.path.join(_ROOT, "scripts", "latest_masters_2026.json")
DEFAULT_RENDERED_DATES = os.path.join(_ROOT, "scripts", "rendered_dates.json")
DEFAULT_AI_MUSH_TAGS = os.path.join(_ROOT, "scripts", "ai_mush_tags.json")
DEFAULT_CATALOG = os.path.expanduser("~/tmp/music_map_staging/catalog_587_enriched.json")
_STAGING_EXCLUSIONS = os.path.expanduser("~/tmp/music_map_staging/exclusions.json")
DEFAULT_EXCLUSIONS = (
    _STAGING_EXCLUSIONS
    if os.path.exists(_STAGING_EXCLUSIONS)
    else os.path.join(_ROOT, "scripts", "exclusions.json")
)
DEFAULT_OUT_JS = os.path.join(_ROOT, "js", "data.js")

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

# Tracks genuinely rendered in 2026 move to the '2026' Era column (post-023035),
# while older timelines being remastered (EP Concepts, Lucid Crystal, Nusrat 2023) stay in their own timelines (post-023037, post-023038).
RENDERED_2026_ERA_IDS = {
    "ecstatic_wave_1",      # Flowing Wave (v33 arrange, 2026-11-21)
    "ecstatic_wave_2",      # Mega Dark Bass (v07 flowing, 2026-11-16)
    "ecstatic_wave_3",      # Afro 06 (2026-09-08)
    "ecstatic_wave_4",      # Great Spirit 01 (2026-01-15)
    "ecstatic_wave_5",      # Ambient Intro - Outro (2026-09-07)
    "ecstatic_wave_9",      # Dark Bit (2026-03-07)
    "ecstatic_wave_11",     # Fast arp 02 (2026-09-10)
    "ecstatic_wave_13",     # Flowing B 02 becca (2026-03-07)
    "ecstatic_wave_14",     # Lyrical 01 (2026-03-07)
    "remixes_commissions_12",  # Mamady Djole vs Charlie Sparks VIP 02 (2026-03-19)
    "sketches_2026_1",      # Arcadian Sunrise 05 (2026-03-22)
}

WIP_ELIGIBLE_ERAS = {
    "sketches_2026",
    "ecstatic_wave",
    "sketches_2024_25",
    "archive_2018_23",
    "archive_2013_18",
    "remixes_commissions",
}

NON_WIP_REMASTER_IDS = {
    "remixes_commissions_15",  # 2023 Nusrat remix remastered in 2026 -> not a recent WIP
}

TITLE_OVERRIDES = {
    "hd_2005_10": "pr3s3nt - As we Enter",
    "present_electro_31": "The Importance of Having Compassion for Humans",
    "present_electro_61": "tripping with Raymond and Stanley at cheese and wine parties",
    "hd_2005_23": "pr3s3nt - Grimy",
    "hd_2005_48": "pr3s3nt - WAR hard mix",
}

INDIE_GUITAR_KEEPER_IDS = {
    "hd_2005_29",         # Mello Heart
    "hd_2005_28",         # Mary J Slinted 2003
    "archive_2013_18_65", # Spudboy - Green Lanes
    "hd_2005_4",          # White Morning
    "bands_archive_10",   # Folkcore
    "present_electro_56", # Space Bandits
    "hd_2005_50",         # Your a Genius
    "bands_archive_6",    # Make It Thru
    "hd_2005_14",         # Cuntray
    "bands_archive_18",   # Mic Test2 Rev (Yon)
    "bands_archive_20",   # Yon-Santa Claus Asbo (Yon)
    "bands_archive_21",   # Yon - Robots Will Replace You (Yon)
}

SPOKEN_WORD_IDS: set[str] = set()

FORCE_NON_SKETCH_IDS = INDIE_GUITAR_KEEPER_IDS | SPOKEN_WORD_IDS | {
    "hd_2005_10",         # pr3s3nt - As we Enter (mix2)
    "hd_2005_34",         # Peng pr3s3nt mix2
    "hd_2005_39",         # Soc All 164bpm
}


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


def load_excluded_ids(exclusions_path: str | None) -> set[str]:
  out = set(DEFAULT_EXCLUDED_IDS)
  if exclusions_path and os.path.exists(exclusions_path):
    with open(exclusions_path, "r", encoding="utf-8") as f:
      obj = json.load(f)
    if isinstance(obj, dict) and "excluded_ids" in obj:
      out.update(str(x) for x in obj["excluded_ids"])
    elif isinstance(obj, list):
      out.update(str(x) for x in obj)
  return out

# Canonical 10-cluster musical slots (idx 0..9)
STYLE_SLOTS = [
    {
        "idx": 0,
        "id": "d0_ambient",
        "label": "Ambient & soundscapes",
        "short_label": "Ambient",
        "hue": 210,
        "discogs_kw": {
            "Electronic---Ambient": 3.0,
            "Electronic---Dungeon Synth": 1.5,
            "Electronic---New Age": 1.5,
            "Electronic---Dark Ambient": 1.8,
            "Electronic---Drone": 2.0,
            "Classical---Post-Modern": 1.8,
            "Classical---Impressionist": 1.4,
        },
        "mood_kw": {"relaxing": 1.8, "meditative": 1.8, "soundscape": 2.0, "space": 1.2},
        "inst_kw": {"synthesizer": 0.6, "piano": 0.9},
    },
    {
        "idx": 1,
        "id": "d1_dub_techno",
        "label": "Hypnotic, dub & microtonal",
        "short_label": "Hypnotic & dub",
        "hue": 240,
        "discogs_kw": {
            "Electronic---Techno": 2.3,
            "Electronic---Dub Techno": 3.0,
            "Electronic---Minimal": 2.2,
            "Electronic---Minimal Techno": 2.3,
            "Electronic---Acid": 1.0,
        },
        "mood_kw": {"space": 2.2, "deep": 1.5, "hypnotic": 1.5},
        "inst_kw": {"synthesizer": 0.7, "bass": 0.4},
    },
    {
        "idx": 2,
        "id": "d2_downtempo",
        "label": "Downtempo & leftfield",
        "short_label": "Downtempo",
        "hue": 170,
        "discogs_kw": {
            "Electronic---Downtempo": 3.0,
            "Electronic---Trip Hop": 2.0,
            "Electronic---Vaporwave": 1.2,
            "Electronic---Leftfield": 1.8,
            "Electronic---Illbient": 1.5,
            "Electronic---Ambient": 0.9,
        },
        "mood_kw": {"relaxing": 0.9, "slow": 1.2, "dark": 0.6, "film": 0.7},
        "inst_kw": {"synthesizer": 0.5},
    },
    {
        "idx": 3,
        "id": "d3_house_deep",
        "label": "House & deep groove",
        "short_label": "House & deep",
        "hue": 140,
        "discogs_kw": {
            "Electronic---House": 2.8,
            "Electronic---Deep House": 3.0,
            "Electronic---Tech House": 1.8,
            "Electronic---Acid House": 1.4,
            "Electronic---Tropical House": 1.2,
        },
        "mood_kw": {"deep": 2.4, "melodic": 0.6},
        "inst_kw": {"bass": 1.2, "synthesizer": 0.5},
    },
    {
        "idx": 4,
        "id": "d4_indie_guitar",
        "label": "Indie, post-punk & guitar",
        "short_label": "Indie & guitar",
        "hue": 38,
        "discogs_kw": {
            "Rock---Punk": 2.5,
            "Rock---Indie Rock": 2.8,
            "Rock---Alternative Rock": 2.6,
            "Rock---Lo-Fi": 2.0,
            "Rock---Psychedelic Rock": 2.0,
            "Rock---Post-Punk": 2.4,
            "Rock---Experimental": 1.5,
        },
        "mood_kw": {"love": 0.8, "energetic": 0.5},
        "inst_kw": {"electricguitar": 3.0, "guitar": 2.6, "acousticguitar": 1.5, "drums": 0.8},
    },
    {
        "idx": 5,
        "id": "d5_electro_techno",
        "label": "Electro, acid & techno",
        "short_label": "Electro & techno",
        "hue": 278,
        "discogs_kw": {
            "Electronic---Electro": 2.8,
            "Electronic---Techno": 1.8,
            "Electronic---Synth-pop": 1.8,
            "Electronic---Synthwave": 1.8,
            "Electronic---Trance": 1.6,
            "Electronic---Tech Trance": 1.6,
            "Electronic---Acid": 1.4,
            "Electronic---EBM": 1.2,
        },
        "mood_kw": {"energetic": 2.0},
        "inst_kw": {"synthesizer": 1.2},
    },
    {
        "idx": 6,
        "id": "d6_idm_industrial",
        "label": "IDM, glitch & industrial",
        "short_label": "IDM & industrial",
        "hue": 24,
        "discogs_kw": {
            "Electronic---Experimental": 2.4,
            "Electronic---Noise": 2.8,
            "Electronic---Industrial": 2.6,
            "Electronic---Chiptune": 2.6,
            "Electronic---Glitch": 2.8,
            "Electronic---IDM": 2.6,
            "Electronic---Abstract": 2.0,
            "Electronic---Power Electronics": 2.2,
        },
        "mood_kw": {"dark": 1.8, "heavy": 1.0, "energetic": 0.6},
        "inst_kw": {"synthesizer": 1.0},
    },
    {
        "idx": 7,
        "id": "d7_dnb_breaks",
        "label": "Jungle, DnB & breakcore",
        "short_label": "DnB & breaks",
        "hue": 345,
        "discogs_kw": {
            "Electronic---Drum n Bass": 3.2,
            "Electronic---Breakcore": 2.8,
            "Electronic---Jungle": 2.8,
            "Electronic---Breakbeat": 2.4,
            "Electronic---IDM": 1.0,
        },
        "mood_kw": {"energetic": 1.2, "dark": 0.8},
        "inst_kw": {"drums": 0.9, "synthesizer": 0.7},
    },
    {
        "idx": 8,
        "id": "d8_meditative_beats",
        "label": "Meditative beats",
        "short_label": "Meditative",
        "hue": 190,
        "discogs_kw": {
            "Electronic---Ambient": 2.8,
            "Electronic---Downtempo": 2.5,
            "Electronic---Dub": 1.6,
            "Electronic---New Age": 1.8,
            "Electronic---Berlin-School": 1.5,
            "Electronic---Chillwave": 1.6,
            "Electronic---Dub Techno": 1.1,
            "Folk, World, & Country---Folk": 1.0,
        },
        "mood_kw": {
            "meditative": 3.2,
            "relaxing": 2.6,
            "calm": 2.2,
            "space": 1.5,
            "dream": 1.5,
            "slow": 1.5,
            "deep": 1.0,
        },
        "inst_kw": {"synthesizer": 0.8, "piano": 1.1, "acousticguitar": 0.8},
    },
    {
        "idx": 9,
        "id": "d9_uk_bass",
        "label": "UK bass, dubstep & juke",
        "short_label": "UK bass & dubstep",
        "hue": 84,
        "discogs_kw": {
            "Electronic---Grime": 2.8,
            "Electronic---Dubstep": 2.8,
            "Electronic---Bassline": 2.6,
            "Electronic---UK Garage": 2.6,
            "Electronic---Juke": 2.6,
            "Electronic---Halftime": 2.4,
            "Hip Hop---Grime": 2.4,
            "Hip Hop---Trap": 2.2,
            "Hip Hop---Cloud Rap": 1.8,
            "Hip Hop---Gangsta": 1.8,
        },
        "mood_kw": {"energetic": 0.8, "slow": 0.8},
        "inst_kw": {"bass": 2.0},
    },
]

# AI genre sub-family groupings (for subtle sub-labels inside the Generative AI Music territory)
AI_SUBFAMILIES = [
    ("ai_sub_orch", "Orchestral & choir", "Orchestral & choir", {8}, 190),
    ("ai_sub_world_exp", "Gamelan & experimental", "Gamelan & exp.", {0, 1, 6}, 210),
    ("ai_sub_downtempo", "Downtempo & melodic", "Downtempo", {2}, 170),
    ("ai_sub_house", "Afro, house & cumbia", "Afro & house", {3, 5}, 140),
    ("ai_sub_bass", "UK bass & dubstep", "UK bass & dubstep", {9, 4}, 84),
    ("ai_sub_dnb", "Drum & bass", "Drum & bass", {7}, 345),
]

EXCLUDED_STYLES = {
    "Comedy",
    "Advertising",
    "Promotional",
    "Therapy",
    "Education",
    "Dialogue",
    "Interview",
    "Monolog",
    "Audiofictions",
    "Public Broadcast",
}
CONDITIONAL_NONMUSIC = {"Spoken Word", "Field Recording"}
PRETTY_STYLE_MAP = {
    "Drum n Bass": "Drum 'n' Bass",
    "Synth-pop": "Synth-Pop",
    "Post-Modern": "Modern Classical",
    "Tech House": "Tech House",
    "Hip Hop": "Hip-Hop",
    "Lo-Fi": "Lo-Fi",
    "RnB/Swing": "R&B / Swing",
}

EXCLUDED_MOODS = {
    "advertising",
    "corporate",
    "commercial",
    "sport",
    "game",
    "background",
    "summer",
    "love",
    "happy",
    "motivational",
    "trailer",
    "holiday",
    "christmas",
    "party",
    "sexy",
}
MOOD_NAME_MAP = {"space": "Spacious", "film": "Cinematic"}
EXCLUDED_INSTRUMENTS = {"computer", "beat"}
INST_NAME_MAP = {
    "electricguitar": "Electric Guitar",
    "acousticguitar": "Acoustic Guitar",
    "drummachine": "Drum Machine",
    "electricpiano": "Electric Piano",
    "doublebass": "Double Bass",
    "bassguitar": "Bass Guitar",
    "pipeorgan": "Pipe Organ",
    "classicalguitar": "Classical Guitar",
}

SKETCH_WORD_RE = re.compile(r"\b(sketch|ruff|idea|test|demo|loop)\b", re.IGNORECASE)


def format_discogs_style(raw_name):
  sub = raw_name.split("---", 1)[-1]
  return PRETTY_STYLE_MAP.get(sub, sub)


def extract_track_discogs_styles(probs, classes):
  order = np.argsort(-probs)
  candidates = []
  for idx in order:
    raw = str(classes[idx])
    p = float(probs[idx])
    sub = raw.split("---", 1)[-1]
    pretty = PRETTY_STYLE_MAP.get(sub, sub)
    if sub in EXCLUDED_STYLES or pretty in EXCLUDED_STYLES:
      continue
    if sub in CONDITIONAL_NONMUSIC and p < 0.18:
      continue
    candidates.append((pretty, p))
    if len(candidates) >= 12:
      break

  if candidates and candidates[0][0] == "Experimental":
    specific = [(s, p) for s, p in candidates[1:] if s != "Experimental" and p >= 0.05]
    if specific:
      reordered = specific[:2] + [candidates[0]] + [
          (s, p) for s, p in candidates[1:] if (s, p) not in specific[:2]
      ]
      candidates = reordered

  out = []
  for s, _ in candidates:
    if s not in out:
      out.append(s)
    if len(out) >= 3:
      break
  return out


def extract_mood_tags(probs, classes):
  order = np.argsort(-probs)
  out = []
  for idx in order:
    raw = str(classes[idx]).lower()
    p = float(probs[idx])
    if p < 0.06:
      break
    if raw in EXCLUDED_MOODS:
      continue
    label = MOOD_NAME_MAP.get(raw, raw.capitalize())
    if label not in out:
      out.append(label)
    if len(out) >= 2:
      break
  return out


def extract_instrument_tags(probs, classes):
  order = np.argsort(-probs)
  out = []
  for idx in order:
    raw = str(classes[idx]).lower()
    p = float(probs[idx])
    if p < 0.12:
      break
    if raw in EXCLUDED_INSTRUMENTS:
      continue
    label = INST_NAME_MAP.get(raw, raw.replace("_", " ").title())
    if label not in out:
      out.append(label)
    if len(out) >= 2:
      break
  return out


def build_seeded_prototypes(
    X_hybrid, discogs_mean, mood_mean, inst_mean, dg_cls, md_cls, in_cls, track_ids=None, perc_shares=None
):
  dg_idx = {str(c): i for i, c in enumerate(dg_cls)}
  md_idx = {str(c): i for i, c in enumerate(md_cls)}
  in_idx = {str(c): i for i, c in enumerate(in_cls)}

  dg_z = (discogs_mean - discogs_mean.mean(0)) / (discogs_mean.std(0) + 1e-4)
  md_z = (mood_mean - mood_mean.mean(0)) / (mood_mean.std(0) + 1e-4)
  in_z = (inst_mean - inst_mean.mean(0)) / (inst_mean.std(0) + 1e-4)

  keeper_rows = (
      [i for i, tid in enumerate(track_ids) if tid in INDIE_GUITAR_KEEPER_IDS]
      if track_ids is not None
      else []
  )
  spoken_rows = (
      {i for i, tid in enumerate(track_ids) if tid in SPOKEN_WORD_IDS}
      if track_ids is not None
      else set()
  )

  seeds = []
  for slot in STYLE_SLOTS:
    if slot["idx"] == 4 and keeper_rows:
      seeds.append(X_hybrid[keeper_rows].mean(axis=0))
      continue
    score = np.zeros(len(discogs_mean), dtype=np.float64)
    for k, w in slot["discogs_kw"].items():
      if k in dg_idx:
        score += w * dg_z[:, dg_idx[k]]
    for k, w in slot["mood_kw"].items():
      if k in md_idx:
        score += w * md_z[:, md_idx[k]]
    for k, w in slot["inst_kw"].items():
      if k in in_idx:
        score += w * in_z[:, in_idx[k]]
    if perc_shares is not None:
      if slot["idx"] == 0:
        score = np.where(perc_shares >= 0.13, score - 6.0, score)
      elif slot["idx"] == 8:
        score = np.where(perc_shares < 0.11, -999.0, score)
        for neg_dg in (
            "Electronic---Techno",
            "Electronic---Electro",
            "Electronic---Glitch",
            "Electronic---Industrial",
            "Electronic---Noise",
            "Electronic---Drum n Bass",
            "Electronic---Breakcore",
            "Electronic---House",
            "Electronic---Dubstep",
        ):
          if neg_dg in dg_idx:
            score -= 1.6 * dg_z[:, dg_idx[neg_dg]]
        for neg_md in ("energetic", "fast", "heavy"):
          if neg_md in md_idx:
            score -= 1.8 * md_z[:, md_idx[neg_md]]
    for sr in spoken_rows:
      score[sr] = -999.0
    top_idx = np.argsort(-score)[:20]
    seeds.append(X_hybrid[top_idx].mean(axis=0))
  return normalize(np.vstack(seeds), norm="l2")


def _rel_catalog_path(local_path: str) -> str:
  for marker in ("/raw_archive/", "/raw_corpus/"):
    if marker in local_path:
      return local_path.split(marker, 1)[1]
  return local_path


def classify_folder_guidance(
    t: dict,
    cat_entry: dict | None,
    med_vibe: float = 0.0,
    edgy_vibe: float = 0.0,
    glitch_idm_vibe: float = 0.0,
    downtempo_prob: float = 0.0,
    dnb_prob: float = 0.0,
    ukb_prob: float = 0.0,
) -> dict:
  """Evaluate author folder priority, Generative AI / Spoken Word membership, and clean Sketch status."""
  tid = str(t.get("id") or "")
  rel_path = _rel_catalog_path(str((cat_entry or {}).get("local_path") or ""))
  low = rel_path.lower()
  title = str(t.get("title") or "")
  title_low = title.lower()
  fname = os.path.basename(rel_path)
  released = bool(t.get("released"))
  full_dur = float(t.get("full_duration_sec") or (cat_entry or {}).get("full_duration_sec") or t.get("duration_sec") or 180.0)
  perc_share = float(t.get("perc_share") if t.get("perc_share") is not None else ((cat_entry or {}).get("perc_share") or 0.1))
  four_on_floor = float(t.get("four_on_floor") if t.get("four_on_floor") is not None else ((cat_entry or {}).get("four_on_floor") or 0.0))
  energy = float(t.get("energy") or 5)

  is_spoken_word = tid in SPOKEN_WORD_IDS
  is_ai = bool(
      not is_spoken_word
      and (
          bool(t.get("is_ai"))
          or tid.startswith("ai_music_")
          or low.startswith("ai music 2025")
          or "/ai gamelan/" in low
          or "/ai afrohouse" in low
      )
  )

  # User rules (post-022787, post-023035): 100% of GenAI tracks and all full-length (>= 75s) tracks have is_sketch = False
  is_sketch = False if (is_ai or is_spoken_word) else bool(
      tid not in FORCE_NON_SKETCH_IDS
      and not released
      and full_dur < 75.0
  )

  prior = np.zeros(10, dtype=np.float64)
  allowed: set[int] | None = None
  rule = "discogs_ml"

  if is_ai:
    ai_cat = str(t.get("ai_cat") or "")
    if ai_cat == "orchestral_choir":
      prior[8] += 0.28
      allowed = {8, 0, 2}
      rule = "ai_folder:orchestral_choir"
    elif ai_cat == "gamelan_experimental":
      prior[1] += 0.16
      prior[6] += 0.16
      prior[0] += 0.12
      allowed = {0, 1, 6, 2}
      rule = "ai_folder:gamelan_experimental"
    elif ai_cat == "downtempo_melodic":
      prior[2] += 0.22
      prior[3] += 0.06
      allowed = {2, 0, 3, 5}
      rule = "ai_folder:downtempo_melodic"
    elif ai_cat == "afro_house_cumbia":
      prior[3] += 0.22
      prior[5] += 0.10
      allowed = {3, 5, 2, 9}
      rule = "ai_folder:afro_house_cumbia"
    elif ai_cat == "bass_drill_dnb":
      is_true_ai_dnb = dnb_prob >= 0.25 or any(
          kw in title_low for kw in ("d&b", "dnb", "d+b", "qzb")
      )
      is_true_uk_bass = ukb_prob >= 0.13 or any(
          kw in title_low for kw in ("drill", "grime", "dubstep", "bmore", "fong", "amanati", "droganos")
      )
      if is_true_ai_dnb:
        prior[7] += 0.34
        allowed = {7}
        rule = "ai_folder:dnb"
      elif is_true_uk_bass:
        prior[9] += 0.24
        allowed = {9}
        rule = "ai_folder:uk_bass_dubstep"
      else:
        prior[9] += 0.06
        allowed = {0, 1, 2, 3, 5, 6, 8, 9}
        rule = "ai_folder:bass_eclectic"
    else:
      allowed = {0, 1, 2, 3, 5, 6, 8, 9}
      rule = "ai_folder:general"
    return {
        "is_ai": True,
        "is_spoken_word": False,
        "is_sketch": False,
        "prior": prior,
        "allowed": allowed,
        "rule": rule,
    }

  if is_spoken_word:
    return {
        "is_ai": False,
        "is_spoken_word": True,
        "is_sketch": False,
        "prior": prior,
        "allowed": {4},
        "rule": "curated:spoken_word_island",
    }

  if tid in INDIE_GUITAR_KEEPER_IDS:
    prior[4] += 0.45
    return {
        "is_ai": False,
        "is_spoken_word": False,
        "is_sketch": False,
        "prior": prior,
        "allowed": {4},
        "rule": "curated:indie_guitar_keeper",
    }

  is_band = False
  if not is_ai and low:
    is_band = any(
        k in low
        for k in ("/my own band", "psykers", "yon/", "spudboy", "random bill bands", "^ jams/")
    ) or ("spudboy -" in title_low or "spudboy —" in title_low or "slint" in title_low)

    if is_band:
      if perc_share < 0.04 and energy <= 3:
        prior[0] += 0.35
        allowed = {0}
        rule = "folder:band_drone_ambient"
      else:
        prior[4] += 0.35
        allowed = {4}
        rule = "folder:bands_and_jams_guitar"
    elif "03 - spirit guides" in low or "dark ambient ep" in low or "jungle and rain atmos" in low:
      if perc_share >= 0.14 and med_vibe >= 0.40:
        prior[8] += 0.28
        prior[0] += 0.10
        allowed = {0, 8}
        rule = "folder:spirit_guides_meditative_beats"
      else:
        prior[0] += 0.28
        prior[2] += 0.06
        allowed = {0, 2}
        rule = "folder:spirit_guides_dark_ambient"
    elif "04 - lucid crystal" in low or "arising and passing" in low:
      if perc_share >= 0.14 and med_vibe >= 0.40:
        prior[8] += 0.30
        prior[0] += 0.08
        allowed = {0, 8}
        rule = "folder:lucid_crystal_meditative_beats"
      else:
        prior[0] += 0.24
        prior[1] += 0.08
        prior[2] += 0.06
        allowed = {0, 1, 2}
        rule = "folder:lucid_crystal_ambient"
    elif "present trax/ambient" in low:
      if perc_share >= 0.105 and energy >= 4:
        prior[8] += 0.32
        allowed = {8}
        rule = "folder:present_ambient_meditative_beats"
      else:
        prior[0] += 0.30
        allowed = {0, 8}
        rule = "folder:present_ambient"
    elif "02 - le garage" in low or "le garage era tracks" in low or "gamelan" in low:
      prior[1] += 0.20
      prior[2] += 0.10
      prior[0] += 0.08
      allowed = {0, 1, 2, 8}
      rule = "folder:le_garage_microtonal"
    elif "06 - ecstatic wave" in low or ("reflective disc" in low and "^ uptempo level match" in low):
      if "06 - ecstatic wave" in low and perc_share < 0.10 and four_on_floor < 10.0:
        prior[0] += 0.28
        prior[8] += 0.08
        allowed = {0, 8}
        rule = "folder:ecstatic_ambient_interlude"
      elif "06 - ecstatic wave" in low and med_vibe >= 0.40 and four_on_floor < 44.0 and edgy_vibe < 0.32:
        prior[8] += 0.30
        prior[2] += 0.08
        allowed = {0, 2, 8}
        rule = "folder:ecstatic_meditative_beats"
      else:
        prior[3] += 0.18
        prior[1] += 0.12
        prior[5] += 0.08
        allowed = {1, 2, 3, 5, 8}
        rule = "folder:ecstatic_uptempo_groove"
    elif any(k in low for k in ("dom piano ravel", "me and mya piano", "kalimba, piano")):
      if perc_share >= 0.12:
        prior[8] += 0.28
        prior[2] += 0.08
        allowed = {8, 2}
        rule = "folder:piano_kalimba_beats"
      else:
        prior[0] += 0.28
        allowed = {0}
        rule = "folder:piano_acoustic_ambient"
    elif "summon downtempo" in low:
      prior[2] += 0.20
      prior[0] += 0.08
      prior[8] += 0.12
      allowed = {0, 2, 8}
      rule = "folder:downtempo"
    elif any(k in low for k in ("d&b", "breakbeat loops", "classic breaks", "vivaldi drill")):
      prior[7] += 0.22
      prior[9] += 0.10
      allowed = {7, 9, 3}
      rule = "folder:dnb_breaks"
    elif "offal beats" in low:
      prior[1] += 0.10
      prior[5] += 0.10
      prior[6] += 0.08
      allowed = {1, 2, 5, 6, 7}
      rule = "folder:offal_beats"
    elif "01 - nihon forever" in low:
      if med_vibe >= 0.45 and perc_share >= 0.10 and edgy_vibe < 0.32:
        prior[8] += 0.24
        prior[0] += 0.08
        rule = "folder:nihon_forever_meditative"
      else:
        prior[5] += 0.10
        prior[3] += 0.10
        prior[1] += 0.08
        rule = "folder:nihon_forever"

  if not is_ai and not is_band:
    allowed = (allowed - {4}) if allowed is not None else {0, 1, 2, 3, 5, 6, 7, 8, 9}
    if perc_share < 0.105:
      # Beatless / minimal-percussion soundscapes belong in Ambient & soundscapes (d0), not Meditative beats (d8)
      prior[0] += 0.14
      prior[8] -= 0.24
    elif med_vibe >= 0.42 and edgy_vibe < 0.25 and 0.105 <= perc_share <= 0.44:
      # Serene, contemplative pulse/rhythmic ambient pieces (incl. Great Spirit 01 & 7rez 01) route to Meditative beats (d8)
      prior[8] += 0.30
      if rule == "folder:le_garage_microtonal":
        prior[1] -= 0.14
    elif edgy_vibe >= 0.42 or perc_share >= 0.50:
      # Edgy/dense leftfield, glitch, IDM & techno beats (like Collaboration perc=0.56, glitchClub=0.45) stay out of Meditative beats
      if rule not in ("folder:present_ambient_meditative_beats", "folder:piano_kalimba_beats"):
        prior[8] -= 0.18
    if (glitch_idm_vibe >= 0.34 or (glitch_idm_vibe >= 0.24 and energy >= 8)) and downtempo_prob < 0.09 and dnb_prob < 0.10 and rule == "discogs_ml":
      # Clean Glitch / IDM / Chiptune / Abstract pieces (e.g. Nameless, Ichi Ban) route to IDM, glitch & industrial without stealing DnB/Jungle
      prior[6] += 0.22
      prior[2] -= 0.16

  return {
      "is_ai": is_ai,
      "is_spoken_word": False,
      "is_sketch": is_sketch,
      "prior": prior,
      "allowed": allowed,
      "rule": rule,
  }


def _deoverlap_points(
    pts, min_sep, x_bounds, y_bounds, anchor_pull=0.025, iters=65, clusters=None, cross_mult=1.0
):
  anchor = pts.copy()
  pos = pts.copy()
  if clusters is not None and cross_mult > 1.0:
    same_c = clusters[:, None] == clusters[None, :]
    sep_mat = np.where(same_c, min_sep, min_sep * cross_mult)
  else:
    sep_mat = min_sep
  for _ in range(iters):
    diff = pos[:, None, :] - pos[None, :, :]
    dist_sq = np.sum(diff * diff, axis=2)
    np.fill_diagonal(dist_sq, 9.0)
    dist = np.sqrt(dist_sq)
    overlap = (dist < sep_mat) & (dist > 1e-9)
    if not np.any(overlap):
      break
    force_mag = np.where(overlap, (sep_mat - dist) / (dist + 1e-6) * 0.38, 0.0)
    disp = np.sum(diff * force_mag[:, :, None], axis=1)
    pos = pos + disp + anchor_pull * (anchor - pos)
    pos[:, 0] = np.clip(pos[:, 0], x_bounds[0], x_bounds[1])
    pos[:, 1] = np.clip(pos[:, 1], y_bounds[0], y_bounds[1])
  return pos


def compute_organic_continuum_and_ai_layout(
    X_hybrid,
    proto_centers,
    priors,
    cluster_idx,
    is_ai_mask,
    is_spoken_mask,
    is_sketch_mask=None,
):
  """Project handcrafted tracks onto a cohesive, airy genre archipelago (spreading out intra-cluster
  nodes into organic de-ribboned clouds while pulling islands closer across crisp, label-friendly channels
  with facing-shore cross-genre cousin alignment), place Generative AI tracks into a rounded 2D
  genre-subdivided archipelago on the right, and isolate Spoken Word tracks if present."""
  n = len(X_hybrid)
  coords = np.zeros((n, 2), dtype=np.float64)

  hc_idx = np.where(~is_ai_mask & ~is_spoken_mask)[0]
  ai_idx = np.where(is_ai_mask)[0]
  sp_idx = np.where(is_spoken_mask)[0]

  # 1. Handcrafted Music: Spread-Cluster + Cohesive-Archipelago Layout in 1:1 Desktop Screen Space [1130x596]
  if len(hc_idx) > 0:
    W_BOX, H_BOX = 1130.0, 596.0
    X_LO, X_HI = 0.062, 0.650
    Y_LO, Y_HI = 0.118, 0.874

    X_hc = X_hybrid[hc_idx]
    hc_clusters = cluster_idx[hc_idx]
    hc_sketch = (
        is_sketch_mask[hc_idx]
        if is_sketch_mask is not None
        else np.zeros(len(hc_idx), dtype=bool)
    )
    vis_mask = ~hc_sketch
    S_hc = X_hc @ X_hc.T

    # 1a. Deterministic PCA-seeded UMAP for local acoustic manifold structure
    pca2 = PCA(n_components=2, random_state=42).fit_transform(X_hc).astype(np.float64)
    amb_m = np.isin(hc_clusters, [0, 8])
    if np.any(amb_m) and pca2[amb_m, 0].mean() > 0:
      pca2[:, 0] = -pca2[:, 0]
    top_m = np.isin(hc_clusters, [3, 5])
    bot_m = np.isin(hc_clusters, [4, 6])
    if np.any(top_m) and np.any(bot_m) and pca2[top_m, 1].mean() > pca2[bot_m, 1].mean():
      pca2[:, 1] = -pca2[:, 1]
    pca_init = (pca2 / (np.std(pca2[:, 0]) + 1e-6) * 8.0).astype(np.float32)

    reducer = umap.UMAP(
        n_neighbors=22,
        min_dist=0.36,
        metric="cosine",
        target_metric="categorical",
        target_weight=0.22,
        init=pca_init,
        compatibility_layout=True,
        random_state=42,
    )
    u_hc = reducer.fit_transform(X_hc, y=hc_clusters).astype(np.float64)
    u_hc = u_hc - np.median(u_hc, axis=0)
    if np.any(amb_m) and u_hc[amb_m, 0].mean() > 0:
      u_hc[:, 0] = -u_hc[:, 0]
    if np.any(top_m) and np.any(bot_m) and u_hc[top_m, 1].mean() > u_hc[bot_m, 1].mean():
      u_hc[:, 1] = -u_hc[:, 1]

    # 1b. Cross-genre acoustic affinity & target island radii (proportional to sqrt(visible count))
    present_clusters = sorted(int(c) for c in set(hc_clusters))
    c_radii = {}
    c_centers_feat = {}
    for c in present_clusters:
      m_all = hc_clusters == c
      m_v = m_all & vis_mask
      n_eff = int(np.sum(m_v)) if np.sum(m_v) >= 4 else int(np.sum(m_all))
      c_radii[c] = 66.0 * math.sqrt(max(10.0, float(n_eff)) / 27.0)
      c_centers_feat[c] = normalize(X_hc[m_all].mean(axis=0, keepdims=True), norm="l2")[0]

    aff = np.zeros((10, 10), dtype=np.float64)
    cross_links = np.zeros((10, 10), dtype=np.float64)
    for ca in present_clusters:
      ia = np.where((hc_clusters == ca) & vis_mask)[0]
      if len(ia) == 0:
        ia = np.where(hc_clusters == ca)[0]
      for cb in present_clusters:
        if ca >= cb:
          continue
        ib = np.where((hc_clusters == cb) & vis_mask)[0]
        if len(ib) == 0:
          ib = np.where(hc_clusters == cb)[0]
        sub = S_hc[np.ix_(ia, ib)].ravel()
        top_k = np.sort(sub)[::-1][: min(8, len(sub))]
        c_cos = float(np.dot(c_centers_feat[ca], c_centers_feat[cb]))
        n_strong = float(np.sum(sub >= 0.65))
        aff[ca, cb] = aff[cb, ca] = 0.55 * float(np.mean(top_k)) + 0.45 * c_cos
        cross_links[ca, cb] = cross_links[cb, ca] = n_strong

    K = len(present_clusters)
    dissim = np.zeros((K, K), dtype=np.float64)
    for ia, ca in enumerate(present_clusters):
      for ib, cb in enumerate(present_clusters):
        if ia == ib:
          continue
        dissim[ia, ib] = max(0.05, 1.0 - aff[ca, cb])

    mds_xy = MDS(
        n_components=2,
        metric="precomputed",
        init="classical_mds",
        random_state=42,
        n_init=1,
        max_iter=500,
        normalized_stress="auto",
    ).fit_transform(dissim)

    # Canonical compass preserving intuitive genre geography (Ambient/Meditative West, Electro/House North,
    # Hypnotic/Downtempo Center, UK bass/DnB East, IDM South-East, Indie outer South coast)
    compass_targets = {
        0: np.array([-1.34,  0.34]),
        8: np.array([-0.60,  0.06]),
        5: np.array([-0.96, -0.64]),
        3: np.array([-0.26, -1.06]),
        1: np.array([ 0.06, -0.46]),
        2: np.array([ 0.10,  0.16]),
        9: np.array([ 0.68, -0.24]),
        7: np.array([ 1.32,  0.06]),
        6: np.array([ 0.62,  0.86]),
        4: np.array([-0.32,  0.98]),
    }
    T_comp = np.array([compass_targets.get(c, np.zeros(2)) for c in present_clusters], dtype=np.float64)
    mds_c = mds_xy - mds_xy.mean(axis=0)
    T_c = T_comp - T_comp.mean(axis=0)
    U_p, _, Vt_p = np.linalg.svd(mds_c.T @ T_c)
    R_p = U_p @ Vt_p
    if np.linalg.det(R_p) < 0:
      Vt_p[-1, :] *= -1
      R_p = U_p @ Vt_p
    mds_aligned = (mds_c @ R_p) / (np.std(mds_c) + 1e-6)

    center_stage = np.array([W_BOX * 0.50, H_BOX * 0.50], dtype=np.float64)
    c_pos = {}
    for ia, c in enumerate(present_clusters):
      init_dir = 0.25 * mds_aligned[ia] + 0.75 * T_comp[ia]
      c_pos[c] = center_stage + init_dir * np.array([345.0, 212.0])

    # Equilibrate island centroids across crisp ~54-68px channels (closing dead gulfs while keeping distinct borders)
    CHANNEL_TARGET_PX = 68.0
    MIN_CENTROID_CLEAR_PX = 78.0
    for _ in range(280):
      forces = {c: np.zeros(2, dtype=np.float64) for c in present_clusters}
      for ia, ca in enumerate(present_clusters):
        nbr_order = sorted(
            [cb for cb in present_clusters if cb != ca],
            key=lambda cb: -(aff[ca, cb] + 0.035 * math.log1p(cross_links[ca, cb])),
        )
        top_nbrs = set(nbr_order[:3])
        for ib, cb in enumerate(present_clusters):
          if ia >= ib:
            continue
          delta = c_pos[cb] - c_pos[ca]
          eff_delta = np.array([delta[0], delta[1] * 1.16], dtype=np.float64)
          dist = float(np.linalg.norm(eff_delta)) + 1e-6
          u = delta / (float(np.linalg.norm(delta)) + 1e-6)
          sum_r = c_radii[ca] + c_radii[cb]
          is_top = (cb in top_nbrs) or (ca in sorted(
              [ck for ck in present_clusters if ck != cb],
              key=lambda ck: -(aff[cb, ck] + 0.035 * math.log1p(cross_links[cb, ck])),
          )[:3])

          min_d = sum_r + (CHANNEL_TARGET_PX if is_top else MIN_CENTROID_CLEAR_PX)
          if dist < min_d:
            push = (min_d - dist) * 0.36
            forces[ca] -= u * push
            forces[cb] += u * push
          elif is_top:
            w_spring = 0.068 * (0.5 + aff[ca, cb]) * (1.0 + 0.12 * math.log1p(cross_links[ca, cb]))
            pull = (dist - (sum_r + CHANNEL_TARGET_PX)) * w_spring
            forces[ca] += u * pull
            forces[cb] -= u * pull

        compass_anchor = center_stage + T_comp[ia] * np.array([350.0, 214.0])
        forces[ca] += (compass_anchor - c_pos[ca]) * 0.065

      for c in present_clusters:
        c_pos[c] += np.clip(forces[c], -15.0, 15.0)
        r_x = c_radii[c] * 1.04
        r_y = c_radii[c] * 0.88
        c_pos[c][0] = float(np.clip(c_pos[c][0], r_x + 8.0, W_BOX - r_x - 8.0))
        c_pos[c][1] = float(np.clip(c_pos[c][1], r_y + 8.0, H_BOX - r_y - 8.0))

    # 1c. Intra-cluster expansion, soft de-ribboning & facing-shore cross-genre cousin alignment
    pts_px = np.zeros((len(hc_idx), 2), dtype=np.float64)
    for c in present_clusters:
      m = np.where(hc_clusters == c)[0]
      if len(m) == 0:
        continue
      if len(m) == 1:
        pts_px[m[0]] = c_pos[c]
        continue

      u_loc = u_hc[m] - np.median(u_hc[m], axis=0)
      cov = np.cov(u_loc.T) + np.eye(2) * 1e-5
      eigvals, eigvecs = np.linalg.eigh(cov)
      order = np.argsort(-eigvals)
      eigvals = eigvals[order]
      eigvecs = eigvecs[:, order]
      proj = u_loc @ eigvecs
      s0 = math.sqrt(max(eigvals[0], 1e-6))
      s1 = math.sqrt(max(eigvals[1], 1e-6))
      proj[:, 0] /= s0
      proj[:, 1] /= max(s1, s0 / 1.28)
      whitened = proj @ eigvecs.T
      whitened = whitened / (np.std(whitened, axis=0, keepdims=True) + 1e-6)

      shore_vec = np.zeros_like(whitened)
      for local_k, gi in enumerate(m):
        v_acc = np.zeros(2, dtype=np.float64)
        for cb in present_clusters:
          if cb == c:
            continue
          ib = np.where(hc_clusters == cb)[0]
          if len(ib) == 0:
            continue
          sims_cb = S_hc[gi, ib]
          top3 = float(np.mean(np.sort(sims_cb)[::-1][: min(3, len(sims_cb))]))
          if top3 > 0.58:
            d_vec = c_pos[cb] - c_pos[c]
            d_len = float(np.linalg.norm(d_vec)) + 1e-6
            prox_w = 1.0 / (1.0 + (d_len / 340.0) ** 2)
            v_acc += ((top3 - 0.58) ** 1.15) * prox_w * (d_vec / d_len)
        shore_vec[local_k] = v_acc

      sh_std = float(np.hypot(shore_vec[:, 0], shore_vec[:, 1]).mean()) + 1e-6
      shore_norm = np.clip(shore_vec / (sh_std * 1.6), -1.35, 1.35)

      blended = 0.68 * whitened + 0.32 * shore_norm
      blended -= np.median(blended, axis=0)

      raw_r = np.hypot(blended[:, 0], blended[:, 1])
      angles = np.arctan2(blended[:, 1], blended[:, 0])
      ranks = np.argsort(np.argsort(raw_r)).astype(np.float64)
      q_u = (ranks + 0.5) / float(len(m))
      r_p90 = max(1e-6, float(np.percentile(raw_r, 90)))
      r_nat = np.clip(raw_r / r_p90, 0.0, 1.12)
      r_frac = 0.65 * np.sqrt(q_u) + 0.35 * r_nat
      R_c = c_radii[c]
      pts_px[m, 0] = c_pos[c][0] + R_c * 1.12 * r_frac * np.cos(angles)
      pts_px[m, 1] = c_pos[c][1] + R_c * 0.90 * r_frac * np.sin(angles)

    # 1d. True screen-pixel relaxation (default-visible first, then <75s sketch tuck-in)
    anchor_px = pts_px.copy()
    vis_idx = np.where(vis_mask)[0]
    sk_idx = np.where(~vis_mask)[0]

    def _relax_hc_subset(indices, fixed_indices, same_sep, cross_sep, anchor_w, r_cap_mult, iters):
      all_active = np.concatenate([fixed_indices, indices]) if len(fixed_indices) > 0 else indices
      if len(all_active) == 0:
        return
      n_fix = len(fixed_indices)
      pos = pts_px[all_active].copy()
      anc = anchor_px[all_active].copy()
      cls = hc_clusters[all_active]
      same_c = cls[:, None] == cls[None, :]
      sep_mat = np.where(same_c, same_sep, cross_sep)

      for _ in range(iters):
        diff = pos[:, None, :] - pos[None, :, :]
        dist_sq = np.sum(diff * diff, axis=2)
        np.fill_diagonal(dist_sq, 1e9)
        dist = np.sqrt(dist_sq)
        overlap = (dist < sep_mat) & (dist > 1e-9)
        if np.any(overlap):
          stiff = np.where(same_c, 0.34, 0.50)
          f_mag = np.where(overlap, (sep_mat - dist) / (dist + 1e-6) * stiff, 0.0)
          disp = np.sum(diff * f_mag[:, :, None], axis=1)
        else:
          disp = np.zeros_like(pos)

        pull = anchor_w * (anc - pos)
        for loc_i in range(n_fix, len(all_active)):
          ci = int(cls[loc_i])
          rel_c = pos[loc_i] - c_pos[ci]
          r_allow = c_radii[ci] * r_cap_mult
          rn = float(np.hypot(rel_c[0] / 1.14, rel_c[1] / 0.92))
          if rn > r_allow:
            pull[loc_i] -= (rel_c / (rn + 1e-6)) * (rn - r_allow) * 0.38

        if n_fix > 0:
          pos[:n_fix] += 0.08 * disp[:n_fix] + 0.35 * (anc[:n_fix] - pos[:n_fix])
          pos[n_fix:] += disp[n_fix:] + pull[n_fix:]
        else:
          pos += disp + pull

        pos[:, 0] = np.clip(pos[:, 0], 4.0, W_BOX - 4.0)
        pos[:, 1] = np.clip(pos[:, 1], 4.0, H_BOX - 4.0)
        hud_hit = (pos[:, 0] < 245.0) & (pos[:, 1] < 44.0)
        pos[hud_hit, 1] = np.maximum(pos[hud_hit, 1], 46.0)

      pts_px[all_active] = pos

    _relax_hc_subset(
        vis_idx,
        np.array([], dtype=np.int32),
        same_sep=20.0,
        cross_sep=52.0,
        anchor_w=0.060,
        r_cap_mult=1.15,
        iters=125,
    )
    anchor_px[vis_idx] = pts_px[vis_idx].copy()

    if len(sk_idx) > 0:
      _relax_hc_subset(
          sk_idx,
          vis_idx,
          same_sep=15.0,
          cross_sep=48.0,
          anchor_w=0.070,
          r_cap_mult=1.15,
          iters=95,
      )

    hc_pts = np.zeros_like(pts_px)
    for dim, (lo, hi) in enumerate(((X_LO, X_HI), (Y_LO, Y_HI))):
      v = pts_px[:, dim]
      vmin, vmax = float(np.min(v)), float(np.max(v))
      hc_pts[:, dim] = lo + ((v - vmin) / max(1e-6, vmax - vmin)) * (hi - lo)

    coords[hc_idx] = hc_pts

  # 2. Generative AI Music: Cohesive Rounded 2D Archipelago in right reserve [0.692..0.952, 0.272..0.825]
  if len(ai_idx) > 0:
    proto_ai = (X_hybrid[ai_idx] @ proto_centers.T) + priors[ai_idx]
    X_ai = np.hstack([X_hybrid[ai_idx], 0.60 * normalize(proto_ai, norm="l2")])
    perp_ai = max(5, min(24, (len(ai_idx) - 1) // 6))
    u_ai = TSNE(
        n_components=2,
        perplexity=perp_ai,
        init="pca",
        learning_rate="auto",
        random_state=42,
    ).fit_transform(X_ai).astype(np.float64)

    # 6-region sub-archipelago inside Generative AI reserve with Drum & bass cleanly separated from Bass & drill (post-023242)
    sub_pockets = {
        "ai_sub_orch":      (np.array([0.754, 0.246]), (0.704, 0.804), (0.192, 0.302)),
        "ai_sub_world_exp": (np.array([0.884, 0.252]), (0.830, 0.942), (0.194, 0.312)),
        "ai_sub_downtempo": (np.array([0.754, 0.448]), (0.702, 0.806), (0.382, 0.514)),
        "ai_sub_house":     (np.array([0.884, 0.476]), (0.826, 0.946), (0.382, 0.570)),
        "ai_sub_bass":      (np.array([0.756, 0.700]), (0.704, 0.808), (0.612, 0.788)),
        "ai_sub_dnb":       (np.array([0.886, 0.716]), (0.840, 0.936), (0.664, 0.768)),
    }
    sub_members_local = {k: [] for k in sub_pockets}
    for local_i, global_i in enumerate(ai_idx):
      cidx = int(cluster_idx[global_i])
      sub_id = "ai_sub_bass"
      for sid, _, _, cset, _ in AI_SUBFAMILIES:
        if cidx in cset:
          sub_id = sid
          break
      sub_members_local[sub_id].append(local_i)

    ai_pts = np.zeros((len(ai_idx), 2), dtype=np.float64)
    for sub_id, loc_indices in sub_members_local.items():
      if not loc_indices:
        continue
      anch, xb, yb = sub_pockets[sub_id]
      u_sub = u_ai[loc_indices]
      for d, (blo, bhi) in enumerate((xb, yb)):
        v = u_sub[:, d]
        span = max(1e-6, float(np.percentile(v, 95) - np.percentile(v, 5)))
        norm_v = np.clip((v - np.median(v)) / span, -0.65, 0.65)
        half_w = (bhi - blo) * 0.43
        ai_pts[loc_indices, d] = np.clip(anch[d] + norm_v * half_w, blo + 0.004, bhi - 0.004)
      ai_pts[loc_indices] = _deoverlap_points(
          ai_pts[loc_indices],
          min_sep=0.0162,
          x_bounds=xb,
          y_bounds=yb,
          anchor_pull=0.035,
          iters=95,
      )
    coords[ai_idx] = ai_pts

  # 3. Spoken Word Mini-Island: Quiet upper-right bay [0.826, 0.074], clear of HUD, music continent, AI box & player card
  if len(sp_idx) > 0:
    sp_pts = np.zeros((len(sp_idx), 2), dtype=np.float64)
    for k in range(len(sp_idx)):
      sp_pts[k] = np.array([0.826 + (k - (len(sp_idx) - 1) * 0.5) * 0.028, 0.074])
    coords[sp_idx] = sp_pts

  return coords


def build_dataset(
    data_js_path,
    features_path,
    catalog_path,
    out_js_path,
    exclusions_path=DEFAULT_EXCLUSIONS,
    genai_bundle_path=DEFAULT_GENAI_BUNDLE,
):
  raw = open(data_js_path, "r", encoding="utf-8").read()
  prefix = "window.CORPUS_DATA = "
  s = raw[raw.index(prefix) + len(prefix) :].rstrip()
  if s.endswith(";"):
    s = s[:-1]
  data = json.loads(s)

  excluded_ids = load_excluded_ids(exclusions_path)
  cat_by_id = {}
  if catalog_path and os.path.exists(catalog_path):
    cat_obj = json.load(open(catalog_path, "r", encoding="utf-8"))
    for ct in cat_obj.get("tracks", []):
      if isinstance(ct, dict) and ct.get("id"):
        tid = str(ct["id"])
        cat_by_id[tid] = ct
        if is_excluded_by_folder_rule(str(ct.get("local_path") or "")):
          excluded_ids.add(tid)

  # Merge 198-track trimmed Generative AI catalog bundle (non-Sandbox tracks only, post-022956)
  genai_by_id = {}
  if genai_bundle_path and os.path.exists(genai_bundle_path):
    g_obj = json.load(open(genai_bundle_path, "r", encoding="utf-8"))
    for gt in g_obj.get("tracks", []):
      if isinstance(gt, dict) and gt.get("id") and str(gt["id"]) not in excluded_ids:
        genai_by_id[str(gt["id"])] = dict(gt)

  def _clean_ai_display_title(raw_t: str) -> str:
    s_t = str(raw_t or "").strip()
    s_t = re.sub(r"\s*-?\s*bw\s+ext\b", "", s_t, flags=re.IGNORECASE)
    s_t = re.sub(r"\s+20\d{2}-\d{2}-\d{2}(?:\s+\d{4})?\b", "", s_t)
    s_t = re.sub(r"\s+_(\d+)$", r" (\1)", s_t)
    s_t = re.sub(r"\s+", " ", s_t).strip()
    if s_t and s_t[0].islower() and not s_t.startswith("pr3s3nt"):
      s_t = s_t[0].upper() + s_t[1:]
    return s_t or str(raw_t or "")

  for gid, gt in genai_by_id.items():
    ct = _clean_ai_display_title(gt.get("title", ""))
    gt["title"] = ct
    gt["shortTitle"] = ct.split(" (")[0][:26] if " (" in ct and len(ct) > 26 else ct[:26]
    gt["preview_start_sec"] = 0.0
    gt["cue_sec"] = 0.0

  feats = np.load(features_path)
  tracks = [t for t in data["tracks"] if str(t.get("id")) not in excluded_ids]
  existing_ids = set()
  for t in tracks:
    tid = str(t.get("id") or "")
    existing_ids.add(tid)
    if tid in genai_by_id:
      # Refresh trimmed duration, peaks, cue_sec, URLs, free_download metadata, and AI flags while keeping existing slot/era
      gt = genai_by_id[tid]
      for k in (
          "title", "shortTitle", "full_duration_sec", "is_sketch", "is_ai", "ai_cat",
          "peaks", "cue_sec", "preview_start_sec", "preview_dur_sec", "duration_sec",
          "bytes", "rms_db", "gain_trim", "stream_url", "preview_url", "preview_release_url", "file",
          "tier", "has_lossless", "dl_ready",
          "mp3_320_url", "mp3_url", "mp3_320_bytes", "mp3_size_mb", "mp3_mb", "mp3_kbps",
          "flac_url", "flac_bytes", "flac_size_mb", "flac_mb",
      ):
        if k in gt:
          t[k] = gt[k]
      if not gt.get("has_lossless"):
        for fk in ("flac_url", "flac_bytes", "flac_size_mb", "flac_mb"):
          t.pop(fk, None)
    if tid in TITLE_OVERRIDES:
      t["title"] = TITLE_OVERRIDES[tid]
      t["shortTitle"] = TITLE_OVERRIDES[tid][:26]

  new_ai_tracks = []
  for gid, gt in genai_by_id.items():
    if gid not in existing_ids:
      tracks.append(gt)
      new_ai_tracks.append(gt)

  yon_new_track = None
  if os.path.exists(DEFAULT_YON_BUNDLE):
    yt = json.load(open(DEFAULT_YON_BUNDLE, "r", encoding="utf-8"))
    yid = str(yt.get("id") or "")
    if yid and yid not in excluded_ids:
      yon_new_track = dict(yt)
      if yid not in existing_ids:
        tracks.append(dict(yt))
        existing_ids.add(yid)
      else:
        for t in tracks:
          if str(t.get("id") or "") == yid:
            t.update(yon_new_track)

  if os.path.exists(DEFAULT_MASTERS_2026_BUNDLE):
    mb = json.load(open(DEFAULT_MASTERS_2026_BUNDLE, "r", encoding="utf-8"))
    masters_by_id = {str(m["id"]): m for m in mb.get("tracks", []) if m.get("id") and str(m["id"]) not in excluded_ids}
    for t in tracks:
      tid = str(t.get("id") or "")
      if tid in masters_by_id:
        t.update(masters_by_id[tid])
    for mid, mt in masters_by_id.items():
      if mid not in existing_ids:
        tracks.append(dict(mt))
        existing_ids.add(mid)

  rendered_dates_map = (
      json.load(open(DEFAULT_RENDERED_DATES, "r", encoding="utf-8"))
      if os.path.exists(DEFAULT_RENDERED_DATES)
      else {}
  )
  ai_mush_by_id = {}
  if os.path.exists(DEFAULT_AI_MUSH_TAGS):
    mush_obj = json.load(open(DEFAULT_AI_MUSH_TAGS, "r", encoding="utf-8"))
    if isinstance(mush_obj, dict) and isinstance(mush_obj.get("tracks"), dict):
      ai_mush_by_id = mush_obj["tracks"]

  data["tracks"] = tracks
  n_tracks = len(tracks)

  feat_id_to_row = {str(x): idx for idx, x in enumerate(feats["track_ids"])}
  row_indices = []
  track_ids = []
  for t in tracks:
    tid = str(t["id"])
    if tid not in feat_id_to_row:
      raise KeyError(f"Track ID {tid} missing from {features_path}!")
    row_indices.append(feat_id_to_row[tid])
    track_ids.append(tid)
  row_idx = np.array(row_indices, dtype=np.int32)

  emb_mean = feats["emb_mean"][row_idx]
  discogs_mean = feats["discogs_mean"][row_idx]
  mood_mean = feats["mood_mean"][row_idx]
  inst_mean = feats["inst_mean"][row_idx]
  dg_cls = feats["discogs_classes"]
  md_cls = feats["mood_classes"]
  in_cls = feats["inst_classes"]

  # Explicit rhythm/tempo/groove DSP block standardized strictly on handcrafted music so 86 BPM pulse vs 130 BPM glitch never collapses
  dsp_rows = []
  hc_prelim = []
  for t in tracks:
    tid = str(t["id"])
    ct = cat_by_id.get(tid) or {}
    is_sp_p = tid in SPOKEN_WORD_IDS
    is_ai_p = bool(t.get("is_ai")) or tid.startswith("ai_music_")
    hc_prelim.append(not is_sp_p and not is_ai_p)
    bpm_val = float(t.get("effective_bpm") or t.get("bpm") or ct.get("bpm") or 120.0)
    bpm_oct = bpm_val
    while bpm_oct >= 158.0:
      bpm_oct *= 0.5
    while bpm_oct < 79.0:
      bpm_oct *= 2.0
    raw_p = t.get("perc_share") if t.get("perc_share") is not None else ct.get("perc_share")
    perc_val = float(raw_p) if raw_p is not None else 0.05
    dc_val = float(t.get("drum_complexity") or ct.get("drum_complexity") or 30.0) / 100.0
    f4_val = float(t.get("four_on_floor") or ct.get("four_on_floor") or 0.0) / 100.0
    brk_val = float(t.get("breakbeat_score") or ct.get("breakbeat_score") or 0.0) / 100.0
    en_val = float(t.get("energy") or ct.get("energy") or 5.0) / 10.0
    dsp_rows.append([
        math.log2(max(40.0, bpm_val)),
        0.7 * math.sin(2.0 * math.pi * math.log2(bpm_oct)),
        0.7 * math.cos(2.0 * math.pi * math.log2(bpm_oct)),
        perc_val * 1.8,
        dc_val * 1.3,
        f4_val * 1.1,
        brk_val * 1.1,
        en_val * 1.1,
    ])
  dsp_arr = np.array(dsp_rows, dtype=np.float64)
  hc_prelim_mask = np.array(hc_prelim, dtype=bool)
  dsp_scaler = StandardScaler().fit(dsp_arr[hc_prelim_mask])
  dsp_l2 = normalize(dsp_scaler.transform(dsp_arr), norm="l2")

  # Rhythm-Enriched Hybrid Feature Space (1280-D Essentia + 400-D Discogs + Jamendo Mood/Inst + DSP Rhythm/Tempo)
  emb_l2 = normalize(emb_mean, norm="l2")
  dg_l2 = normalize(np.log1p(12.0 * discogs_mean), norm="l2")
  md_l2 = normalize(np.log1p(8.0 * mood_mean), norm="l2")
  in_l2 = normalize(np.log1p(8.0 * inst_mean), norm="l2")
  X_hybrid = normalize(
      np.hstack([emb_l2, 0.68 * dg_l2, 0.25 * md_l2, 0.25 * in_l2, 0.40 * dsp_l2]), norm="l2"
  )

  # Refresh 8-D sonic similarity walk vector from rhythm-enriched X_hybrid across all tracks
  pca8 = PCA(n_components=8, random_state=42).fit_transform(X_hybrid)
  pca8 = (pca8 - pca8.mean(axis=0)) / (pca8.std(axis=0) + 1e-6)
  for i, t in enumerate(tracks):
    t["feat_vec"] = [round(float(x), 3) for x in pca8[i]]

  perc_shares = np.array([
      float(
          t.get("perc_share")
          if t.get("perc_share") is not None
          else ((cat_by_id.get(str(t["id"])) or {}).get("perc_share") or 0.05)
      )
      for t in tracks
  ], dtype=np.float64)

  dg_map = {str(c): idx for idx, c in enumerate(dg_cls)}
  md_map = {str(c): idx for idx, c in enumerate(md_cls)}
  med_vibes = np.zeros(n_tracks, dtype=np.float64)
  edgy_vibes = np.zeros(n_tracks, dtype=np.float64)
  glitch_idm_vibes = np.zeros(n_tracks, dtype=np.float64)
  downtempo_probs = discogs_mean[:, dg_map["Electronic---Downtempo"]] if "Electronic---Downtempo" in dg_map else np.zeros(n_tracks)
  dnb_probs = np.zeros(n_tracks, dtype=np.float64)
  for k in ("Electronic---Drum n Bass", "Electronic---Jungle"):
    if k in dg_map:
      dnb_probs += discogs_mean[:, dg_map[k]]
  ukb_probs = np.zeros(n_tracks, dtype=np.float64)
  for k in ("Electronic---Dubstep", "Electronic---Grime", "Hip Hop---Trap", "Electronic---UK Garage", "Electronic---Bassline"):
    if k in dg_map:
      ukb_probs += discogs_mean[:, dg_map[k]]
  for k, w in (
      ("meditative", 1.0),
      ("relaxing", 1.0),
      ("calm", 1.0),
      ("space", 1.0),
      ("dream", 1.0),
      ("slow", 1.0),
      ("soundscape", 0.7),
      ("deep", 0.6),
  ):
    if k in md_map:
      med_vibes += w * mood_mean[:, md_map[k]]
  for k in (
      "Electronic---Techno",
      "Electronic---Electro",
      "Electronic---Glitch",
      "Electronic---Industrial",
      "Electronic---Noise",
      "Electronic---Drum n Bass",
      "Electronic---Breakcore",
      "Electronic---House",
      "Electronic---Dubstep",
  ):
    if k in dg_map:
      edgy_vibes += discogs_mean[:, dg_map[k]]
  for k in (
      "Electronic---Glitch",
      "Electronic---IDM",
      "Electronic---Chiptune",
      "Electronic---Abstract",
      "Electronic---Industrial",
      "Electronic---Noise",
  ):
    if k in dg_map:
      glitch_idm_vibes += discogs_mean[:, dg_map[k]]

  # Fit prototypes & KMeans strictly on handcrafted musical tracks (~is_ai & ~is_spoken) so handcrafted clusters never drift!
  prelim_guidance = [
      classify_folder_guidance(
          t,
          cat_by_id.get(str(t["id"])),
          med_vibe=float(med_vibes[i]),
          edgy_vibe=float(edgy_vibes[i]),
          glitch_idm_vibe=float(glitch_idm_vibes[i]),
          downtempo_prob=float(downtempo_probs[i]),
          dnb_prob=float(dnb_probs[i]),
          ukb_prob=float(ukb_probs[i]),
      )
      for i, t in enumerate(tracks)
  ]
  hc_fit_mask = np.array(
      [not g["is_ai"] and not g["is_spoken_word"] for g in prelim_guidance],
      dtype=bool,
  )
  hc_track_ids = [tid for tid, m in zip(track_ids, hc_fit_mask) if m]
  seeds = build_seeded_prototypes(
      X_hybrid[hc_fit_mask],
      discogs_mean[hc_fit_mask],
      mood_mean[hc_fit_mask],
      inst_mean[hc_fit_mask],
      dg_cls,
      md_cls,
      in_cls,
      track_ids=hc_track_ids,
      perc_shares=perc_shares[hc_fit_mask],
  )
  km = KMeans(n_clusters=10, init=seeds, n_init=1, max_iter=300, random_state=42)
  km.fit(X_hybrid[hc_fit_mask])
  proto_centers = normalize(km.cluster_centers_, norm="l2")

  base_scores = X_hybrid @ proto_centers.T
  priors = np.zeros((n_tracks, 10), dtype=np.float64)
  cluster_idx = np.zeros(n_tracks, dtype=np.int32)
  is_ai_mask = np.zeros(n_tracks, dtype=bool)
  is_spoken_mask = np.zeros(n_tracks, dtype=bool)
  is_sketch_mask = np.zeros(n_tracks, dtype=bool)
  folder_rules = []

  for i, t in enumerate(tracks):
    guidance = prelim_guidance[i]
    is_ai_mask[i] = guidance["is_ai"]
    is_spoken_mask[i] = guidance["is_spoken_word"]
    is_sketch_mask[i] = guidance["is_sketch"]
    priors[i] = guidance["prior"]
    folder_rules.append(guidance["rule"])

    if guidance["is_spoken_word"]:
      cluster_idx[i] = 10
      continue

    sc = base_scores[i] + guidance["prior"]
    allowed = guidance["allowed"]
    if allowed is not None:
      masked = np.full(10, -999.0, dtype=np.float64)
      for c in allowed:
        masked[c] = sc[c]
      cluster_idx[i] = int(np.argmax(masked))
    else:
      cluster_idx[i] = int(np.argmax(sc))

  coords = compute_organic_continuum_and_ai_layout(
      X_hybrid,
      proto_centers,
      priors,
      cluster_idx,
      is_ai_mask,
      is_spoken_mask,
      is_sketch_mask=is_sketch_mask,
  )

  hc_mask = ~is_ai_mask & ~is_spoken_mask
  sil_hybrid = float(silhouette_score(X_hybrid[hc_mask], cluster_idx[hc_mask], metric="cosine"))
  sil_2d = float(silhouette_score(coords[hc_mask], cluster_idx[hc_mask], metric="euclidean"))

  sim_mat = X_hybrid @ X_hybrid.T

  track_updates = {}
  slot_by_idx = {slot["idx"]: slot for slot in STYLE_SLOTS}
  old_track_map = data["meta"].get("track_map", {})
  new_track_map = {}
  new_track_near = {}

  ai_sub_members = {sid: [] for sid, *_ in AI_SUBFAMILIES}

  for i, t in enumerate(tracks):
    tid = str(t["id"])
    cidx = int(cluster_idx[i])
    is_sp = bool(is_spoken_mask[i])
    is_ai = bool(is_ai_mask[i])
    is_sk = bool(is_sketch_mask[i])
    mood_tags = extract_mood_tags(mood_mean[i], md_cls)
    inst_tags = extract_instrument_tags(inst_mean[i], in_cls)

    if is_sp:
      upd = {
          "cluster_id": "spoken_word",
          "cluster_label": "Spoken word · 1983",
          "cluster_idx": 10,
          "is_ai": False,
          "is_spoken_word": True,
          "is_sketch": False,
          "discogs_styles": ["Spoken Word"],
          "discogs_top": "Spoken Word",
          "mood_tags": mood_tags,
          "instrument_tags": ["Voice"],
      }
    else:
      slot = slot_by_idx[cidx]
      dg_styles = extract_track_discogs_styles(discogs_mean[i], dg_cls)
      ai_sub_id = None
      ai_sub_label = None
      if is_ai:
        for sid, slbl, _, cset, _ in AI_SUBFAMILIES:
          if cidx in cset:
            ai_sub_id = sid
            ai_sub_label = slbl
            ai_sub_members[sid].append(tid)
            break
      upd = {
          "cluster_id": "ai_generative" if is_ai else slot["id"],
          "cluster_label": f"Generative AI · {ai_sub_label or slot['short_label']}" if is_ai else slot["label"],
          "cluster_idx": cidx,
          "is_ai": is_ai,
          "is_spoken_word": False,
          "is_sketch": is_sk,
          "discogs_styles": dg_styles,
          "discogs_top": dg_styles[0] if dg_styles else slot["short_label"],
          "mood_tags": mood_tags,
          "instrument_tags": inst_tags,
      }
      if ai_sub_id:
        upd["ai_sub_id"] = ai_sub_id
        upd["ai_sub_label"] = ai_sub_label
    if tid in TITLE_OVERRIDES:
      upd["title"] = TITLE_OVERRIDES[tid]
      upd["shortTitle"] = TITLE_OVERRIDES[tid][:26]
    if not is_ai:
      res_era, res_yr, res_slot = bd.resolve_present_1997_2004_era(
          tid, str(t.get("era") or ""), t.get("year"), t.get("slot")
      )
      if res_era != t.get("era") or tid in bd.PRESENT_1997_2004_ERA_MAP:
        upd["era"] = res_era
        upd["year"] = res_yr
        upd["slot"] = res_slot
      if tid in RENDERED_2026_ERA_IDS or str(upd.get("era") or t.get("era") or "") == "sketches_2026":
        upd["era"] = "sketches_2026"
        upd["year"] = 2026
      elif str(upd.get("era") or t.get("era") or "") == "lucid_crystal":
        upd["year"] = 2022

    eff_era = str(upd.get("era") or t.get("era") or "")
    eff_yr = int(upd.get("year") or t.get("year") or 2020)
    if is_ai:
      # Start all Generative AI tracks at 0:00 instead of mid-track preview cue (post-023279, post-023287)
      upd["cue_sec"] = 0.0
      upd["preview_start_sec"] = 0.0
      upd["cue_in_sec"] = 0.0
      upd["wip_eligible"] = False
      upd["rendered_at"] = str(t.get("rendered_at") or f"{eff_yr:04d}-06-15")
      mush_entry = ai_mush_by_id.get(tid)
      if isinstance(mush_entry, dict) and mush_entry.get("has_mush") and mush_entry.get("mush_onset_sec") is not None:
        upd["has_mush"] = True
        upd["mush_onset_sec"] = round(float(mush_entry["mush_onset_sec"]), 1)
      else:
        t.pop("has_mush", None)
        t.pop("mush_onset_sec", None)
    else:
      t.pop("has_mush", None)
      t.pop("mush_onset_sec", None)
      iso_date = str(rendered_dates_map.get(tid) or t.get("rendered_at") or f"{eff_yr:04d}-06-15")
      is_rel = bool(t.get("released"))
      upd["rendered_at"] = iso_date
      upd["wip_eligible"] = bool(
          not is_sk
          and not is_rel
          and eff_era in WIP_ELIGIBLE_ERAS
          and tid not in NON_WIP_REMASTER_IDS
      )

    t.update(upd)
    t.pop("track_near", None)
    t.pop("ai_cat", None)
    for forbidden in ("local_path", "rel_path", "remote_path", "rel_dropbox_path"):
      t.pop(forbidden, None)
    track_updates[tid] = upd

    xy = [round(float(coords[i, 0]), 4), round(float(coords[i, 1]), 4)]
    default_era_xy = old_track_map.get("bands_archive_20", {}).get("era", xy) if tid == "bands_archive_21" else xy
    era_xy = old_track_map.get(tid, {}).get("era", default_era_xy)
    new_track_map[tid] = {"vibe": xy, "similarity": xy, "era": era_xy}

  # Acoustically-ranked nearest neighbors within same territory:
  # top intra-constellation siblings first (for smooth autoplay walks & constellation spine),
  # followed by genuine cross-genre / cross-subfamily cousins (X_hybrid cosine >= 0.645 handcrafted / >= 0.68 AI)
  # so neighboring constellations weave into a truthful sonic web without fake pixel bridges!
  ai_sub_arr = np.array([str(t.get("ai_sub_id") or "") for t in tracks])
  for i, t in enumerate(tracks):
    tid = str(t["id"])
    cidx = int(cluster_idx[i])
    is_sp = bool(is_spoken_mask[i])
    is_ai = bool(is_ai_mask[i])
    if is_sp:
      new_track_near[tid] = []
      continue

    sims = sim_mat[i].copy()
    sims[i] = -2.0
    sims[is_spoken_mask] = -2.0
    sims[is_ai_mask != is_ai] = -2.0

    if is_ai:
      my_sub = ai_sub_arr[i]
      same_c_mask = (ai_sub_arr == my_sub) & (sims >= 0.45)
      other_c_mask = (ai_sub_arr != my_sub) & (sims >= 0.68)
      same_nn = [int(j) for j in np.argsort(-np.where(same_c_mask, sims, -2.0)) if same_c_mask[j]][:12]
      other_nn = [int(j) for j in np.argsort(-np.where(other_c_mask, sims, -2.0)) if other_c_mask[j]][:8]
      nn_idx = same_nn + other_nn
    else:
      same_c_mask = (cluster_idx == cidx) & (sims >= 0.28)
      other_c_mask = (cluster_idx != cidx) & (sims >= 0.645)
      same_vis_mask = same_c_mask & (~is_sketch_mask)
      same_vis_nn = [int(j) for j in np.argsort(-np.where(same_vis_mask, sims, -2.0)) if same_vis_mask[j]][:10]
      same_sk_nn = [int(j) for j in np.argsort(-np.where(same_c_mask, sims, -2.0)) if same_c_mask[j] and j not in set(same_vis_nn)][:4]
      other_vis_mask = other_c_mask & (~is_sketch_mask)
      other_vis_nn = [int(j) for j in np.argsort(-np.where(other_vis_mask, sims, -2.0)) if other_vis_mask[j]][:8]
      other_sk_nn = [int(j) for j in np.argsort(-np.where(other_c_mask, sims, -2.0)) if other_c_mask[j] and j not in set(other_vis_nn)][:4]
      nn_idx = same_vis_nn + same_sk_nn + other_vis_nn + other_sk_nn

    new_track_near[tid] = [
        [tracks[j]["id"], round(float(sims[j]), 3)] for j in nn_idx
    ]

  # Keep data["eras"] & data["phases"] strictly handcrafted non-AI tracks so Ableton analytical views stay pure
  tracks_by_id = {str(t["id"]): t for t in tracks}
  ai_id_set = {str(t["id"]) for t in tracks if t.get("is_ai")}
  for section, target_id in (("eras", "bands_archive"), ("phases", "phase0_archive")):
    for item in data.get(section, []):
      kept_sub = []
      seen_ids = set()
      for sub_t in item.get("tracks", []):
        if isinstance(sub_t, dict) and sub_t.get("id") in tracks_by_id:
          stid = str(sub_t["id"])
          if stid in ai_id_set:
            continue
          seen_ids.add(stid)
          sub_copy = dict(sub_t)
          sub_copy.update(tracks_by_id[stid])
          kept_sub.append(sub_copy)
      if yon_new_track is not None and "bands_archive_21" in tracks_by_id and "bands_archive_21" not in seen_ids:
        if str(item.get("id") or "") == target_id:
          kept_sub.append(dict(tracks_by_id["bands_archive_21"]))
      item["tracks"] = kept_sub

  # Rebuild the 4 chronological 1997–2004 sub-eras + sync all Era headers/counts/tracks + Phase 0: Archive + era_anchors cleanly
  hc_tracks_by_era = {}
  for t in tracks:
    if t.get("is_ai"):
      continue
    hc_tracks_by_era.setdefault(str(t.get("era") or ""), []).append(t)
  for ek, elist in hc_tracks_by_era.items():
    elist.sort(key=lambda r: (int(r.get("slot") or 999), str(r.get("id") or "")))

  existing_eras_by_id = {
      str(item.get("id")): item
      for item in data.get("eras", [])
      if isinstance(item, dict) and item.get("id") not in {"present_ambient", "present_electro"}
  }
  present_4_ids = {"present_early_97", "present_breaks_99", "present_med_house_01", "present_arcadian_03"}
  rebuilt_eras = []
  for ekey, elabel, eshort, eyears, ephase, ptag, enote in bd.ERA_META:
    e_trks = [dict(x) for x in hc_tracks_by_era.get(ekey, [])]
    if ekey in present_4_ids or ekey not in existing_eras_by_id:
      rebuilt_eras.append(
          bd.extract_archive_item(
              ekey,
              elabel,
              eshort,
              eyears,
              e_trks,
              extra={"phase": ephase, "phaseTag": ptag, "note": enote, "tracks": e_trks},
          )
      )
    else:
      er_copy = dict(existing_eras_by_id[ekey])
      er_copy["label"] = elabel
      er_copy["shortLabel"] = eshort
      er_copy["sublabel"] = eyears
      er_copy["audio_files"] = len(e_trks)
      er_copy["tracks"] = e_trks
      rebuilt_eras.append(er_copy)
  data["eras"] = rebuilt_eras

  p0_all_tracks = [t for ek in bd.ARCHIVE_ERAS for t in hc_tracks_by_era.get(ek, [])]
  p0_rep_tracks = []
  for ek in bd.ARCHIVE_ERAS:
    for rep_t in hc_tracks_by_era.get(ek, [])[:2]:
      t_rep = dict(rep_t)
      t_rep["slot"] = len(p0_rep_tracks) + 1
      p0_rep_tracks.append(t_rep)
  rebuilt_phases = []
  for item in data.get("phases", []):
    if isinstance(item, dict) and item.get("id") == "phase0_archive":
      rebuilt_phases.append(
          bd.extract_archive_item(
              "phase0_archive",
              "Phase 0: Archive",
              "P0 Archive",
              "1997–2014",
              p0_all_tracks,
              extra={"daw": "Early DAWs & Archive", "note": "Pre-2013 audio archive bounces", "tracks": p0_rep_tracks},
          )
      )
    else:
      rebuilt_phases.append(item)
  data["phases"] = rebuilt_phases

  n_eras_tot = max(1, len(rebuilt_eras))
  rebuilt_anchors = []
  for e_idx, er_obj in enumerate(rebuilt_eras):
    eid = str(er_obj["id"])
    ax = round(0.045 + (0.91 * e_idx / max(1, n_eras_tot - 1)), 4)
    e_trks = hc_tracks_by_era.get(eid, [])
    mean_ey = (
        round(sum(max(0.05, min(0.95, 1.0 - (float(x.get("energy") or 5.0) - 1.0) / 9.0)) for x in e_trks) / len(e_trks), 4)
        if e_trks else 0.5
    )
    rebuilt_anchors.append({"id": eid, "idx": e_idx, "x": ax, "y": 0.9, "cx": ax, "cy": mean_ey})
  data["meta"]["era_anchors"] = rebuilt_anchors

  style_groups = []
  for cidx in range(10):
    slot = slot_by_idx[cidx]
    mem_indices = np.where((cluster_idx == cidx) & (~is_ai_mask) & (~is_spoken_mask))[0]
    if len(mem_indices) == 0:
      continue
    members = [tracks[j]["id"] for j in mem_indices]
    cx = round(float(np.median(coords[mem_indices, 0])), 4)
    cy = round(float(np.median(coords[mem_indices, 1])), 4)
    style_groups.append({
        "id": slot["id"],
        "label": slot["label"],
        "short_label": slot["short_label"],
        "idx": cidx,
        "hue": slot["hue"],
        "members": members,
        "cx": cx,
        "cy": cy,
    })

  sp_indices = np.where(is_spoken_mask)[0]
  if len(sp_indices) > 0:
    style_groups.append({
        "id": "spoken_word",
        "label": "Spoken word",
        "short_label": "Spoken word",
        "idx": 10,
        "hue": 42,
        "is_spoken_group": True,
        "members": [tracks[j]["id"] for j in sp_indices],
        "cx": round(float(np.median(coords[sp_indices, 0])), 4),
        "cy": round(float(np.min(coords[sp_indices, 1])) - 0.032, 4),
    })

  ai_indices = np.where(is_ai_mask)[0]
  if len(ai_indices) > 0:
    ai_subs = []
    for sid, slbl, sshort, _, shue in AI_SUBFAMILIES:
      mids = ai_sub_members[sid]
      if not mids:
        continue
      sub_pts = np.array([new_track_map[mid]["vibe"] for mid in mids], dtype=np.float64)
      ai_subs.append({
          "id": sid,
          "label": slbl,
          "short_label": sshort,
          "hue": shue,
          "members": mids,
          "cx": round(float(np.median(sub_pts[:, 0])), 4),
          "cy": round(float(np.median(sub_pts[:, 1])), 4),
      })
    style_groups.append({
        "id": "ai_generative",
        "label": "Generative AI music",
        "short_label": "AI music",
        "idx": 5,
        "hue": 278,
        "is_ai_group": True,
        "members": [tracks[j]["id"] for j in ai_indices],
        "sub_groups": ai_subs,
        "cx": round(float(np.median(coords[ai_indices, 0])), 4),
        "cy": round(float(np.min(coords[ai_indices, 1])) - 0.035, 4),
    })

  data["meta"]["total_map_tracks"] = n_tracks
  data["meta"]["classifier"] = "essentia-discogs400"
  data["meta"]["classifier_label"] = "Folder-Guided Essentia Discogs-400"
  data["meta"]["silhouette"] = round(sil_2d, 3)
  data["meta"]["silhouette_feature"] = round(sil_hybrid, 3)
  if len(ai_indices) > 0:
    data["meta"]["ai_territory_box"] = [
        round(float(np.min(coords[ai_indices, 0])) - 0.006, 3),
        round(float(np.min(coords[ai_indices, 1])) - 0.012, 3),
        round(float(np.max(coords[ai_indices, 0])) + 0.006, 3),
        round(float(np.max(coords[ai_indices, 1])) + 0.010, 3),
    ]
  else:
    data["meta"]["ai_territory_box"] = [0.716, 0.245, 0.966, 0.885]
  data["meta"]["style_groups"] = style_groups
  data["meta"]["track_map"] = new_track_map
  data["meta"]["track_near"] = new_track_near

  out_text = (
      "// Auto-generated Folder-Guided Essentia Discogs-400 + Organic Continuum & AI Territory map data.\n"
      + "window.CORPUS_DATA = "
      + json.dumps(data, separators=(",", ":"), ensure_ascii=False)
      + ";\n"
  )
  with open(out_js_path, "w", encoding="utf-8") as f:
    f.write(out_text)

  sk_cnt = int(is_sketch_mask.sum())
  ai_cnt = int(is_ai_mask.sum())
  ai_vis = int((is_ai_mask & ~is_sketch_mask).sum())
  print(f"Wrote {out_js_path} ({os.path.getsize(out_js_path)/1e6:.2f} MB)")
  print(f"Tracks: {n_tracks} total | Default visible (full): {n_tracks - sk_cnt} | Sketches: {sk_cnt} | AI total: {ai_cnt} ({ai_vis} default visible)")
  print(f"Handcrafted Silhouette: UMAP-2D={sil_2d:.3f}, Hybrid-Cosine={sil_hybrid:.3f}")
  print("Folder rule counts:", dict(Counter(folder_rules).most_common()))
  print("\n=== Handcrafted Clusters + AI Territory ===")
  for g in style_groups:
    vis_m = sum(1 for mid in g["members"] if not track_updates[mid]["is_sketch"])
    print(f"  {g['id']:17s} | total={len(g['members']):3d} (default_vis={vis_m:3d}) | {g['label']}")
    for sg in g.get("sub_groups", []):
      sv = sum(1 for mid in sg["members"] if not track_updates[mid]["is_sketch"])
      print(f"     └─ {sg['id']:16s} | total={len(sg['members']):2d} (default_vis={sv:2d}) | {sg['label']}")


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-js", default=DEFAULT_DATA_JS)
  parser.add_argument("--features", default=DEFAULT_FEATURES)
  parser.add_argument("--catalog", default=DEFAULT_CATALOG)
  parser.add_argument("--exclusions", default=DEFAULT_EXCLUSIONS)
  parser.add_argument("--out", default=DEFAULT_OUT_JS)
  args = parser.parse_args()
  build_dataset(args.data_js, args.features, args.catalog, args.out, args.exclusions)


if __name__ == "__main__":
  main()

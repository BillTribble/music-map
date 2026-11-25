#!/usr/bin/env python3
"""Build unified Folder-Prioritized Essentia Discogs-400 + Organic Continuum & AI Territory dataset (js/data.js)."""

import argparse
from collections import Counter
import json
import os
import re

import numpy as np
from sklearn.cluster import KMeans
from sklearn.manifold import TSNE
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_JS = os.path.join(_ROOT, "js", "data.js")
DEFAULT_FEATURES = "/tmp/music_map_discogs_features.npz"
DEFAULT_CATALOG = os.path.expanduser("~/tmp/music_map_staging/catalog_587_enriched.json")
DEFAULT_EXCLUSIONS = os.path.expanduser("~/tmp/music_map_staging/exclusions.json")
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
}

TITLE_OVERRIDES = {
    "hd_2005_10": "pr3s3nt - As we Enter",
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
}

SPOKEN_WORD_IDS = {
    "bands_archive_17",   # me - Bill in China 1983
}

FORCE_NON_SKETCH_IDS = INDIE_GUITAR_KEEPER_IDS | SPOKEN_WORD_IDS | {
    "hd_2005_10",         # pr3s3nt - As we Enter (mix2)
    "hd_2005_34",         # Peng pr3s3nt mix2
    "hd_2005_39",         # Soc All 164bpm
}


def is_excluded_by_folder_rule(path_str: str) -> bool:
  if not path_str:
    return False
  parts = [p.strip() for p in path_str.lower().split("/") if p.strip()]
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
        "label": "Ambient & meditative",
        "short_label": "Ambient",
        "hue": 210,
        "discogs_kw": {
            "Electronic---Ambient": 3.0,
            "Electronic---Dungeon Synth": 1.5,
            "Electronic---New Age": 1.5,
            "Electronic---Dark Ambient": 1.8,
            "Electronic---Drone": 1.8,
        },
        "mood_kw": {"relaxing": 1.8, "meditative": 2.0, "soundscape": 1.5, "space": 0.9},
        "inst_kw": {"synthesizer": 0.6},
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
            "Electronic---Chiptune": 2.4,
            "Electronic---Glitch": 2.4,
            "Electronic---IDM": 2.0,
            "Electronic---Power Electronics": 2.2,
        },
        "mood_kw": {"dark": 2.2, "heavy": 1.0},
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
        "id": "d8_piano_acoustic",
        "label": "Piano, classical & folk",
        "short_label": "Piano & acoustic",
        "hue": 190,
        "discogs_kw": {
            "Classical---Post-Modern": 3.0,
            "Classical---Impressionist": 2.5,
            "Classical---Modern": 2.4,
            "Classical---Contemporary": 2.4,
            "Folk, World, & Country---Folk": 2.6,
            "Rock---Neofolk": 2.2,
        },
        "mood_kw": {"relaxing": 1.0, "film": 1.4, "emotional": 1.0},
        "inst_kw": {"piano": 3.5, "acousticguitar": 1.8, "violin": 1.5, "cello": 1.5},
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
    ("ai_sub_orch", "Orchestral & choir", "Orchestral & choir", {0, 8}, 190),
    ("ai_sub_downtempo", "Downtempo & leftfield", "Downtempo", {2}, 170),
    ("ai_sub_house", "House & afro", "House & afro", {3, 5}, 140),
    ("ai_sub_bass", "Bass, drill & DnB", "Bass & DnB", {7, 9, 6, 4, 1}, 84),
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


def build_seeded_prototypes(X_hybrid, discogs_mean, mood_mean, inst_mean, dg_cls, md_cls, in_cls, track_ids=None):
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


def classify_folder_guidance(t: dict, cat_entry: dict | None) -> dict:
  """Evaluate author folder priority, Generative AI / Spoken Word membership, and clean Sketch status."""
  tid = str(t.get("id") or "")
  rel_path = _rel_catalog_path(str((cat_entry or {}).get("local_path") or ""))
  low = rel_path.lower()
  title = str(t.get("title") or "")
  title_low = title.lower()
  fname = os.path.basename(rel_path)
  released = bool(t.get("released"))
  full_dur = float(t.get("full_duration_sec") or (cat_entry or {}).get("full_duration_sec") or t.get("duration_sec") or 180.0)
  perc_share = float((cat_entry or {}).get("perc_share") or t.get("perc_share") or 0.1)
  four_on_floor = float((cat_entry or {}).get("four_on_floor") or t.get("four_on_floor") or 0.0)
  energy = float(t.get("energy") or 5)

  is_spoken_word = tid in SPOKEN_WORD_IDS
  is_ai = bool(
      not is_spoken_word
      and (
          low.startswith("ai music 2025")
          or "musicfx ai test" in low
          or "/ai gamelan/" in low
          or "/ai afrohouse" in low
      )
  )

  in_sketch_dir = "sketches" in low
  has_sketch_word = bool(SKETCH_WORD_RE.search(title) or SKETCH_WORD_RE.search(fname))
  is_sketch = bool(
      tid not in FORCE_NON_SKETCH_IDS
      and not released
      and (in_sketch_dir or has_sketch_word or (full_dur < 75.0 and not is_ai and not is_spoken_word))
  )

  prior = np.zeros(10, dtype=np.float64)
  allowed: set[int] | None = None
  rule = "discogs_ml"

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
      prior[0] += 0.28
      prior[2] += 0.06
      allowed = {0, 2}
      rule = "folder:spirit_guides_dark_ambient"
    elif "04 - lucid crystal" in low or "arising and passing" in low:
      prior[0] += 0.22
      prior[1] += 0.08
      prior[2] += 0.06
      allowed = {0, 1, 2}
      rule = "folder:lucid_crystal_ambient"
    elif "present trax/ambient" in low:
      if perc_share >= 0.16 and energy >= 4:
        prior[2] += 0.22
        prior[0] += 0.10
        allowed = {0, 2}
        rule = "folder:present_ambient_downtempo"
      else:
        prior[0] += 0.28
        allowed = {0, 2}
        rule = "folder:present_ambient"
    elif "02 - le garage" in low or "le garage era tracks" in low or "gamelan" in low:
      prior[1] += 0.20
      prior[2] += 0.10
      prior[0] += 0.08
      allowed = {0, 1, 2}
      rule = "folder:le_garage_microtonal"
    elif "06 - ecstatic wave" in low or ("reflective disc" in low and "^ uptempo level match" in low):
      if "06 - ecstatic wave" in low and perc_share < 0.10 and four_on_floor < 10.0:
        prior[0] += 0.24
        prior[2] += 0.08
        allowed = {0, 2, 8}
        rule = "folder:ecstatic_ambient_interlude"
      else:
        prior[3] += 0.18
        prior[1] += 0.12
        prior[5] += 0.08
        allowed = {1, 2, 3, 5}
        rule = "folder:ecstatic_uptempo_groove"
    elif any(k in low for k in ("dom piano ravel", "me and mya piano", "kalimba, piano")):
      prior[8] += 0.26
      allowed = {8, 0, 2}
      rule = "folder:piano_acoustic"
    elif "summon downtempo" in low:
      prior[2] += 0.20
      prior[0] += 0.08
      prior[8] += 0.08
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
      prior[5] += 0.10
      prior[3] += 0.10
      prior[1] += 0.08
      rule = "folder:nihon_forever"

  if not is_ai and not is_band:
    allowed = (allowed - {4}) if allowed is not None else {0, 1, 2, 3, 5, 6, 7, 8, 9}

  return {
      "is_ai": is_ai,
      "is_spoken_word": False,
      "is_sketch": is_sketch,
      "prior": prior,
      "allowed": allowed,
      "rule": rule,
  }


def _deoverlap_points(pts, min_sep, x_bounds, y_bounds, anchor_pull=0.025, iters=65):
  anchor = pts.copy()
  pos = pts.copy()
  for _ in range(iters):
    diff = pos[:, None, :] - pos[None, :, :]
    dist_sq = np.sum(diff * diff, axis=2)
    np.fill_diagonal(dist_sq, 9.0)
    dist = np.sqrt(dist_sq)
    overlap = (dist < min_sep) & (dist > 1e-9)
    if not np.any(overlap):
      break
    force_mag = np.where(overlap, (min_sep - dist) / (dist + 1e-6) * 0.38, 0.0)
    disp = np.sum(diff * force_mag[:, :, None], axis=1)
    pos = pos + disp + anchor_pull * (anchor - pos)
    pos[:, 0] = np.clip(pos[:, 0], x_bounds[0], x_bounds[1])
    pos[:, 1] = np.clip(pos[:, 1], y_bounds[0], y_bounds[1])
  return pos


def compute_organic_continuum_and_ai_layout(
    X_hybrid, proto_centers, priors, cluster_idx, is_ai_mask, is_spoken_mask
):
  """Project handcrafted tracks onto one organic t-SNE continuum (matching d939dcca organic spacing & blurring),
  place Generative AI tracks into a rounded 2D genre-subdivided archipelago on the right,
  and isolate Spoken Word tracks onto their own quiet mini-island in the upper-right bay."""
  n = len(X_hybrid)
  coords = np.zeros((n, 2), dtype=np.float64)

  hc_idx = np.where(~is_ai_mask & ~is_spoken_mask)[0]
  ai_idx = np.where(is_ai_mask)[0]
  sp_idx = np.where(is_spoken_mask)[0]

  # 1. Handcrafted Music: Continuous PCA-initialized t-SNE Manifold + Honeycombed Organic Spacing
  # Soft Discogs-400 + folder affinity guides genre peninsulas while preserving natural shoreline blurring.
  proto_aff = (X_hybrid[hc_idx] @ proto_centers.T) + priors[hc_idx]
  proto_aff_z = (proto_aff - proto_aff.mean(axis=0)) / (proto_aff.std(axis=0) + 1e-5)
  proto_soft = np.exp(1.20 * proto_aff_z)
  proto_soft = proto_soft / (proto_soft.sum(axis=1, keepdims=True) + 1e-9)
  hc_onehot = np.eye(10, dtype=np.float64)[cluster_idx[hc_idx]]
  X_hc = np.hstack([
      X_hybrid[hc_idx] * 1.25,
      normalize(proto_soft, norm="l2") * 0.58,
      hc_onehot * 0.12,
  ])

  perp_hc = min(34, max(16, len(hc_idx) // 14))
  u_hc = TSNE(
      n_components=2,
      perplexity=perp_hc,
      init="pca",
      learning_rate="auto",
      random_state=42,
  ).fit_transform(X_hc).astype(np.float64)

  # Orient principal axis horizontally (ambient/acoustic on left -> club/bass/breaks/guitar across core & right)
  u_centered = u_hc - u_hc.mean(axis=0)
  cov = np.cov(u_centered.T)
  eigvals, eigvecs = np.linalg.eigh(cov)
  order = np.argsort(-eigvals)
  rot = u_centered @ eigvecs[:, order]

  amb_mask = np.isin(cluster_idx[hc_idx], [0, 8])
  if np.any(amb_mask) and rot[amb_mask, 0].mean() > 0:
    rot[:, 0] = -rot[:, 0]
  house_mask = np.isin(cluster_idx[hc_idx], [3, 9])
  if np.any(house_mask) and rot[house_mask, 1].mean() > 0:
    rot[:, 1] = -rot[:, 1]

  # Gentle 10% pull toward cluster median + soft outer-outlier pull so genres touch & blur across shared borders!
  hc_clusters = cluster_idx[hc_idx]
  for c in range(10):
    m = hc_clusters == c
    if np.sum(m) >= 2:
      med = np.median(rot[m], axis=0)
      rot[m] = 0.90 * rot[m] + 0.10 * med

  center = np.median(rot, axis=0)
  rel = rot - center
  radii = np.hypot(rel[:, 0] / (np.std(rel[:, 0]) + 1e-6), rel[:, 1] / (np.std(rel[:, 1]) + 1e-6))
  r_knee = 1.15
  compress = np.where(radii > r_knee, (r_knee + 0.50 * (radii - r_knee)) / np.maximum(radii, 1e-6), 1.0)
  rot = center + rel * compress[:, None]

  x_lo, x_hi = 0.082, 0.705
  y_lo, y_hi = 0.130, 0.870
  hc_pts = np.zeros_like(rot)
  for dim, (lo, hi) in enumerate(((x_lo, x_hi), (y_lo, y_hi))):
    v = rot[:, dim]
    p1, p99 = np.percentile(v, 0.8), np.percentile(v, 99.2)
    lin = np.clip((v - p1) / max(1e-6, p99 - p1), 0.0, 1.0)
    hc_pts[:, dim] = lo + lin * (hi - lo)

  # Keep top-left HUD pill corner clear
  hud_mask = (hc_pts[:, 0] < 0.24) & (hc_pts[:, 1] < 0.165)
  hc_pts[hud_mask, 1] = np.maximum(hc_pts[hud_mask, 1], 0.170)

  # Honeycombed organic dot spacing (matching d939dcca...)
  hc_pts = _deoverlap_points(
      hc_pts,
      min_sep=0.0195,
      x_bounds=(0.052, 0.732),
      y_bounds=(0.095, 0.905),
      anchor_pull=0.025,
      iters=70,
  )
  coords[hc_idx] = hc_pts

  # 2. Generative AI Music: Isolated Rounded 2D Archipelago in right reserve [0.798..0.958, 0.285..0.655]
  if len(ai_idx) > 0:
    proto_ai = X_hybrid[ai_idx] @ proto_centers.T
    X_ai = np.hstack([X_hybrid[ai_idx], 0.55 * normalize(proto_ai, norm="l2")])
    perp_ai = max(3, min(6, (len(ai_idx) - 1) // 3))
    u_ai = TSNE(
        n_components=2,
        perplexity=perp_ai,
        init="pca",
        learning_rate="auto",
        random_state=42,
    ).fit_transform(X_ai).astype(np.float64)

    ai_x_lo, ai_x_hi = 0.812, 0.946
    ai_y_lo, ai_y_hi = 0.305, 0.640
    ai_pts = np.zeros_like(u_ai)
    for dim, (lo, hi) in enumerate(((ai_x_lo, ai_x_hi), (ai_y_lo, ai_y_hi))):
      v = u_ai[:, dim]
      vmin, vmax = float(v.min()), float(v.max())
      lin = (v - vmin) / max(1e-6, vmax - vmin)
      ai_pts[:, dim] = lo + lin * (hi - lo)

    # 2x2 organic rounded sub-archipelago so AI music is balanced horizontally & vertically (never a skinny line!)
    sub_anchors = {
        "ai_sub_orch": np.array([0.840, 0.340]),
        "ai_sub_downtempo": np.array([0.922, 0.375]),
        "ai_sub_house": np.array([0.836, 0.545]),
        "ai_sub_bass": np.array([0.920, 0.585]),
    }
    for local_i, global_i in enumerate(ai_idx):
      cidx = int(cluster_idx[global_i])
      sub_id = "ai_sub_bass"
      for sid, _, _, cset, _ in AI_SUBFAMILIES:
        if cidx in cset:
          sub_id = sid
          break
      ai_pts[local_i] = 0.42 * ai_pts[local_i] + 0.58 * sub_anchors[sub_id]

    ai_pts = _deoverlap_points(
        ai_pts,
        min_sep=0.025,
        x_bounds=(0.798, 0.958),
        y_bounds=(0.285, 0.655),
        anchor_pull=0.05,
        iters=80,
    )
    coords[ai_idx] = ai_pts

  # 3. Spoken Word Mini-Island: Quiet upper-right bay [0.880, 0.115], clear of HUD, music continent, AI box & player card
  if len(sp_idx) > 0:
    sp_pts = np.zeros((len(sp_idx), 2), dtype=np.float64)
    for k in range(len(sp_idx)):
      sp_pts[k] = np.array([0.880 + (k - (len(sp_idx) - 1) * 0.5) * 0.028, 0.115])
    coords[sp_idx] = sp_pts

  return coords


def build_dataset(data_js_path, features_path, catalog_path, out_js_path, exclusions_path=DEFAULT_EXCLUSIONS):
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

  feats = np.load(features_path)
  tracks = [t for t in data["tracks"] if str(t.get("id")) not in excluded_ids]
  for t in tracks:
    tid = str(t.get("id") or "")
    if tid in TITLE_OVERRIDES:
      t["title"] = TITLE_OVERRIDES[tid]
      t["shortTitle"] = TITLE_OVERRIDES[tid][:26]
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

  # Hybrid feature space
  emb_l2 = normalize(emb_mean, norm="l2")
  dg_l2 = normalize(np.log1p(12.0 * discogs_mean), norm="l2")
  md_l2 = normalize(np.log1p(8.0 * mood_mean), norm="l2")
  in_l2 = normalize(np.log1p(8.0 * inst_mean), norm="l2")
  X_hybrid = normalize(
      np.hstack([emb_l2, 0.65 * dg_l2, 0.20 * md_l2, 0.30 * in_l2]), norm="l2"
  )

  seeds = build_seeded_prototypes(
      X_hybrid, discogs_mean, mood_mean, inst_mean, dg_cls, md_cls, in_cls, track_ids=track_ids
  )
  non_spoken_fit = np.array([tid not in SPOKEN_WORD_IDS for tid in track_ids], dtype=bool)
  km = KMeans(n_clusters=10, init=seeds, n_init=1, max_iter=300, random_state=42)
  km.fit(X_hybrid[non_spoken_fit])
  proto_centers = normalize(km.cluster_centers_, norm="l2")

  base_scores = X_hybrid @ proto_centers.T
  priors = np.zeros((n_tracks, 10), dtype=np.float64)
  cluster_idx = np.zeros(n_tracks, dtype=np.int32)
  is_ai_mask = np.zeros(n_tracks, dtype=bool)
  is_spoken_mask = np.zeros(n_tracks, dtype=bool)
  is_sketch_mask = np.zeros(n_tracks, dtype=bool)
  folder_rules = []

  for i, t in enumerate(tracks):
    tid = str(t["id"])
    guidance = classify_folder_guidance(t, cat_by_id.get(tid))
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
      X_hybrid, proto_centers, priors, cluster_idx, is_ai_mask, is_spoken_mask
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
          "cluster_label": f"Generative AI · {slot['short_label']}" if is_ai else slot["label"],
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

    t.update(upd)
    t.pop("track_near", None)
    track_updates[tid] = upd

    xy = [round(float(coords[i, 0]), 4), round(float(coords[i, 1]), 4)]
    era_xy = old_track_map.get(tid, {}).get("era", xy)
    new_track_map[tid] = {"vibe": xy, "similarity": xy, "era": era_xy}

    # Nearest neighbors strictly within same territory (0 cross-edges into/out of Spoken Word or AI)
    if is_sp:
      new_track_near[tid] = []
    else:
      sims = sim_mat[i].copy()
      sims[i] = -2.0
      sims[is_spoken_mask] = -2.0
      sims[is_ai_mask != is_ai] = -2.0
      nn_idx = [int(j) for j in np.argsort(-sims) if sims[j] > -1.0][:6]
      new_track_near[tid] = [
          [tracks[j]["id"], round(float(sims[j]), 3)] for j in nn_idx
      ]

  for section in ("eras", "phases"):
    for item in data.get(section, []):
      kept_sub = []
      for sub_t in item.get("tracks", []):
        if isinstance(sub_t, dict) and sub_t.get("id") in track_updates:
          sub_t.update(track_updates[sub_t["id"]])
          kept_sub.append(sub_t)
      item["tracks"] = kept_sub

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
  data["meta"]["ai_territory_box"] = [0.818, 0.115, 0.975, 0.585]
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

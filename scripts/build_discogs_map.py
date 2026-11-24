#!/usr/bin/env python3
"""Build Discogs-400 + MTG-Jamendo UMAP corpus dataset (js/data-discogs.js)."""

import argparse
from collections import Counter
import json
import os

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize
import umap

DEFAULT_DATA_JS = "/usr/local/google/home/tribble/music-map/js/data.js"
DEFAULT_FEATURES = "/tmp/music_map_discogs_features.npz"
DEFAULT_OUT_JS = "/usr/local/google/home/tribble/music-map/js/data-discogs.js"

# Canonical 10-cluster slots (idx 0..9)
STYLE_SLOTS = [
    {
        "idx": 0,
        "id": "d0_ambient",
        "label": "Ambient & meditative",
        "short_label": "Ambient",
        "hue": 210,
        "discogs_kw": {"Electronic---Ambient": 3.0, "Electronic---Dungeon Synth": 1.5, "Electronic---New Age": 1.5, "Electronic---Dark Ambient": 1.5},
        "mood_kw": {"relaxing": 1.8, "meditative": 2.0, "soundscape": 1.4, "space": 0.8},
        "inst_kw": {"synthesizer": 0.6},
    },
    {
        "idx": 1,
        "id": "d1_dub_techno",
        "label": "Hypnotic & dub techno",
        "short_label": "Dub techno",
        "hue": 240,
        "discogs_kw": {"Electronic---Techno": 2.5, "Electronic---Dub Techno": 3.0, "Electronic---Minimal": 2.0, "Electronic---Minimal Techno": 2.2, "Electronic---Acid": 1.0},
        "mood_kw": {"space": 2.2, "deep": 1.5},
        "inst_kw": {"synthesizer": 0.7, "bass": 0.4},
    },
    {
        "idx": 2,
        "id": "d2_downtempo",
        "label": "Downtempo & leftfield",
        "short_label": "Downtempo",
        "hue": 170,
        "discogs_kw": {"Electronic---Downtempo": 3.0, "Electronic---Trip Hop": 2.0, "Electronic---Vaporwave": 1.2, "Electronic---Leftfield": 1.8, "Electronic---Illbient": 1.5, "Electronic---Ambient": 1.0},
        "mood_kw": {"relaxing": 0.9, "slow": 1.2, "dark": 0.6, "film": 0.7},
        "inst_kw": {"synthesizer": 0.5},
    },
    {
        "idx": 3,
        "id": "d3_house_deep",
        "label": "House & deep groove",
        "short_label": "House & deep",
        "hue": 140,
        "discogs_kw": {"Electronic---House": 2.8, "Electronic---Deep House": 3.0, "Electronic---Tech House": 1.8, "Electronic---Acid House": 1.4, "Electronic---Tropical House": 1.2},
        "mood_kw": {"deep": 2.4, "melodic": 0.6},
        "inst_kw": {"bass": 1.2, "synthesizer": 0.5},
    },
    {
        "idx": 4,
        "id": "d4_indie_guitar",
        "label": "Indie, post-punk & guitar",
        "short_label": "Indie & guitar",
        "hue": 38,
        "discogs_kw": {"Rock---Punk": 2.5, "Rock---Indie Rock": 2.8, "Rock---Alternative Rock": 2.6, "Rock---Lo-Fi": 2.0, "Rock---Psychedelic Rock": 2.0, "Rock---Post-Punk": 2.4, "Rock---Experimental": 1.5},
        "mood_kw": {"love": 0.8, "energetic": 0.5},
        "inst_kw": {"electricguitar": 3.0, "guitar": 2.6, "acousticguitar": 1.5, "drums": 0.8},
    },
    {
        "idx": 5,
        "id": "d5_electro_techno",
        "label": "Electro, acid & techno",
        "short_label": "Electro & techno",
        "hue": 278,
        "discogs_kw": {"Electronic---Electro": 2.8, "Electronic---Techno": 1.8, "Electronic---Synth-pop": 1.8, "Electronic---Synthwave": 1.8, "Electronic---Trance": 1.6, "Electronic---Tech Trance": 1.6, "Electronic---Acid": 1.4, "Electronic---EBM": 1.2},
        "mood_kw": {"energetic": 2.0},
        "inst_kw": {"synthesizer": 1.2},
    },
    {
        "idx": 6,
        "id": "d6_idm_industrial",
        "label": "IDM, glitch & industrial",
        "short_label": "IDM & industrial",
        "hue": 24,
        "discogs_kw": {"Electronic---Experimental": 2.4, "Electronic---Noise": 2.8, "Electronic---Industrial": 2.6, "Electronic---Chiptune": 2.4, "Electronic---Glitch": 2.4, "Electronic---IDM": 2.0, "Electronic---Power Electronics": 2.2},
        "mood_kw": {"dark": 2.2, "heavy": 1.0},
        "inst_kw": {"synthesizer": 1.0},
    },
    {
        "idx": 7,
        "id": "d7_dnb_breaks",
        "label": "Jungle, DnB & breakcore",
        "short_label": "DnB & breaks",
        "hue": 345,
        "discogs_kw": {"Electronic---Drum n Bass": 3.2, "Electronic---Breakcore": 2.8, "Electronic---Jungle": 2.8, "Electronic---Breakbeat": 2.4, "Electronic---IDM": 1.0},
        "mood_kw": {"energetic": 1.2, "dark": 0.8},
        "inst_kw": {"drums": 0.9, "synthesizer": 0.7},
    },
    {
        "idx": 8,
        "id": "d8_piano_acoustic",
        "label": "Piano, classical & folk",
        "short_label": "Piano & acoustic",
        "hue": 190,
        "discogs_kw": {"Classical---Post-Modern": 3.0, "Classical---Impressionist": 2.5, "Classical---Modern": 2.4, "Classical---Contemporary": 2.4, "Folk, World, & Country---Folk": 2.6, "Rock---Neofolk": 2.2},
        "mood_kw": {"relaxing": 1.0, "film": 1.4, "emotional": 1.0},
        "inst_kw": {"piano": 3.5, "acousticguitar": 1.8, "violin": 1.5, "cello": 1.5},
    },
    {
        "idx": 9,
        "id": "d9_uk_bass",
        "label": "UK bass, dubstep & juke",
        "short_label": "UK bass & dubstep",
        "hue": 84,
        "discogs_kw": {"Electronic---Grime": 2.8, "Electronic---Dubstep": 2.8, "Electronic---Bassline": 2.6, "Electronic---UK Garage": 2.6, "Electronic---Juke": 2.6, "Electronic---Halftime": 2.4, "Hip Hop---Grime": 2.4, "Hip Hop---Trap": 2.2, "Hip Hop---Cloud Rap": 1.8, "Hip Hop---Gangsta": 1.8},
        "mood_kw": {"energetic": 0.8, "slow": 0.8},
        "inst_kw": {"bass": 2.0},
    },
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
MOOD_NAME_MAP = {
    "space": "Spacious",
    "film": "Cinematic",
}

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

  # Promote specific subgenres (prob >= 0.05) ahead of "Experimental" if Experimental is #1
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


def build_seeded_prototypes(X_hybrid, discogs_mean, mood_mean, inst_mean, dg_cls, md_cls, in_cls):
  dg_idx = {str(c): i for i, c in enumerate(dg_cls)}
  md_idx = {str(c): i for i, c in enumerate(md_cls)}
  in_idx = {str(c): i for i, c in enumerate(in_cls)}

  dg_z = (discogs_mean - discogs_mean.mean(0)) / (discogs_mean.std(0) + 1e-4)
  md_z = (mood_mean - mood_mean.mean(0)) / (mood_mean.std(0) + 1e-4)
  in_z = (inst_mean - inst_mean.mean(0)) / (inst_mean.std(0) + 1e-4)

  seeds = []
  for slot in STYLE_SLOTS:
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
    top_idx = np.argsort(-score)[:20]
    seeds.append(X_hybrid[top_idx].mean(axis=0))
  return normalize(np.vstack(seeds), norm="l2")


def _rank_quantile_2d(pts, x_range=(0.14, 0.86), y_range=(0.16, 0.84)):
  n = len(pts)
  out = np.zeros_like(pts, dtype=np.float64)
  for dim, (lo, hi) in enumerate((x_range, y_range)):
    order = np.argsort(pts[:, dim], kind="mergesort")
    ranks = np.empty(n, dtype=np.float64)
    ranks[order] = np.linspace(0.0, 1.0, n)
    out[:, dim] = lo + ranks * (hi - lo)
  return out


def _relax_centroids(c_anchor, x_range=(0.14, 0.86), y_range=(0.16, 0.84)):
  pos = c_anchor.copy()
  min_c_sep = 0.23
  max_nn_dist = 0.255
  for _ in range(250):
    diff = pos[:, None, :] - pos[None, :, :]
    d2 = np.sum(diff * diff, axis=2)
    np.fill_diagonal(d2, 9.0)
    d = np.sqrt(d2)

    # Repel centroids closer than min_c_sep
    rep_mask = d < min_c_sep
    rep_mag = np.where(rep_mask, (min_c_sep - d) / (d + 1e-6) * 0.28, 0.0)
    disp = np.sum(diff * rep_mag[:, :, None], axis=1)

    # Pull any stranded centroid toward its nearest neighbor if gap > max_nn_dist
    nn_idx = np.argmin(d, axis=1)
    for k in range(len(pos)):
      nd = d[k, nn_idx[k]]
      if nd > max_nn_dist:
        pull = (nd - max_nn_dist) / (nd + 1e-6) * 0.35
        disp[k] -= pull * diff[k, nn_idx[k]]

    # Gentle anchor retention to preserve relative UMAP topology
    pos = pos + disp + 0.06 * (c_anchor - pos)
    pos[:, 0] = np.clip(pos[:, 0], x_range[0], x_range[1])
    pos[:, 1] = np.clip(pos[:, 1], y_range[0], y_range[1])
  return pos


def scale_and_spread_coords(u_sup, cluster_idx):
  # 1. Relax the 10 cluster centroids via rank-quantile + repulsive/nn-spring layout
  c_umap = np.array([u_sup[cluster_idx == k].mean(axis=0) for k in range(10)], dtype=np.float64)
  c_anchor = _rank_quantile_2d(c_umap, x_range=(0.14, 0.86), y_range=(0.16, 0.84))
  c_relaxed = _relax_centroids(c_anchor, x_range=(0.14, 0.86), y_range=(0.16, 0.84))

  # 2. Place tracks around relaxed centroids using scaled UMAP local offsets
  counts = np.array([(cluster_idx == k).sum() for k in range(10)], dtype=np.float64)
  mean_n = counts.mean()
  anchor = np.zeros_like(u_sup, dtype=np.float64)
  for k in range(10):
    m = cluster_idx == k
    delta = (u_sup[m] - c_umap[k]).astype(np.float64)
    rad = np.sqrt(np.sum(delta * delta, axis=1))
    r92 = max(1e-6, float(np.percentile(rad, 92)))
    target_rad = float(np.clip(0.085 * np.sqrt(counts[k] / mean_n), 0.06, 0.11))
    scale = target_rad / r92
    # Soft-compress the top 8% radial tails so no outlier shoots across clusters
    norm_r = rad * scale
    soft_r = np.where(norm_r > target_rad, target_rad + 0.25 * target_rad * np.tanh((norm_r - target_rad) / target_rad), norm_r)
    unit_dir = delta / np.maximum(1e-8, rad[:, None])
    anchor[m] = c_relaxed[k] + unit_dir * soft_r[:, None]

  anchor[:, 0] = np.clip(anchor[:, 0], 0.05, 0.95)
  anchor[:, 1] = np.clip(anchor[:, 1], 0.07, 0.93)

  # 3. Smooth pairwise repulsion to eliminate overlapping knots
  pos = anchor.copy()
  min_sep = 0.018
  for _ in range(60):
    diff = pos[:, None, :] - pos[None, :, :]
    dist_sq = np.sum(diff * diff, axis=2)
    np.fill_diagonal(dist_sq, 1.0)
    dist = np.sqrt(dist_sq)
    overlap = (dist < min_sep) & (dist > 1e-9)
    if not np.any(overlap):
      break
    force_mag = np.where(overlap, (min_sep - dist) / (dist + 1e-6) * 0.40, 0.0)
    disp = np.sum(diff * force_mag[:, :, None], axis=1)
    pos = pos + disp + 0.15 * (anchor - pos)
    pos[:, 0] = np.clip(pos[:, 0], 0.05, 0.95)
    pos[:, 1] = np.clip(pos[:, 1], 0.07, 0.93)

  return pos


def build_dataset(data_js_path, features_path, out_js_path):
  raw = open(data_js_path, "r").read()
  prefix = "window.CORPUS_DATA = "
  s = raw[raw.index(prefix) + len(prefix) :].rstrip()
  if s.endswith(";"):
    s = s[:-1]
  data = json.loads(s)

  feats = np.load(features_path)
  tracks = data["tracks"]
  n_tracks = len(tracks)

  feat_ids = [str(x) for x in feats["track_ids"]]
  data_ids = [t["id"] for t in tracks]
  assert feat_ids == data_ids, "Track ID order mismatch between data.js and .npz!"

  emb_mean = feats["emb_mean"]
  discogs_mean = feats["discogs_mean"]
  mood_mean = feats["mood_mean"]
  inst_mean = feats["inst_mean"]
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
      X_hybrid, discogs_mean, mood_mean, inst_mean, dg_cls, md_cls, in_cls
  )
  km = KMeans(n_clusters=10, init=seeds, n_init=1, max_iter=300, random_state=42)
  cluster_idx = km.fit_predict(X_hybrid).astype(np.int32)

  sil_hybrid = float(silhouette_score(X_hybrid, cluster_idx, metric="cosine"))

  # Target-guided UMAP
  reducer = umap.UMAP(
      n_neighbors=20,
      min_dist=0.18,
      metric="cosine",
      target_metric="categorical",
      target_weight=0.32,
      random_state=42,
  )
  coords_raw = reducer.fit_transform(X_hybrid, y=cluster_idx)
  coords = scale_and_spread_coords(coords_raw, cluster_idx)
  sil_2d = float(silhouette_score(coords, cluster_idx, metric="euclidean"))

  # Cosine similarity for top-4 nearest neighbors
  sim_mat = X_hybrid @ X_hybrid.T

  # Update tracks and build lookup by id
  track_updates = {}
  slot_by_idx = {slot["idx"]: slot for slot in STYLE_SLOTS}
  old_track_map = data["meta"]["track_map"]
  new_track_map = {}
  new_track_near = {}

  for i, t in enumerate(tracks):
    tid = t["id"]
    cidx = int(cluster_idx[i])
    slot = slot_by_idx[cidx]
    dg_styles = extract_track_discogs_styles(discogs_mean[i], dg_cls)
    mood_tags = extract_mood_tags(mood_mean[i], md_cls)
    inst_tags = extract_instrument_tags(inst_mean[i], in_cls)

    upd = {
        "cluster_id": slot["id"],
        "cluster_label": slot["label"],
        "cluster_idx": cidx,
        "discogs_styles": dg_styles,
        "discogs_top": dg_styles[0],
        "mood_tags": mood_tags,
        "instrument_tags": inst_tags,
    }
    t.update(upd)
    track_updates[tid] = upd

    xy = [round(float(coords[i, 0]), 4), round(float(coords[i, 1]), 4)]
    era_xy = old_track_map.get(tid, {}).get("era", xy)
    new_track_map[tid] = {"vibe": xy, "similarity": xy, "era": era_xy}

    # Top-4 nearest neighbors (excluding self)
    sims = sim_mat[i].copy()
    sims[i] = -2.0
    nn_idx = np.argsort(-sims)[:4]
    new_track_near[tid] = [
        [tracks[j]["id"], round(float(sims[j]), 3)] for j in nn_idx
    ]

  # Sync updates into data["eras"][*]["tracks"] and data["phases"][*]["tracks"]
  for section in ("eras", "phases"):
    for item in data.get(section, []):
      for sub_t in item.get("tracks", []):
        if isinstance(sub_t, dict) and sub_t.get("id") in track_updates:
          sub_t.update(track_updates[sub_t["id"]])

  # Build meta.style_groups
  style_groups = []
  for cidx in range(10):
    slot = slot_by_idx[cidx]
    mem_indices = np.where(cluster_idx == cidx)[0]
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

  data["meta"]["classifier"] = "essentia-discogs400"
  data["meta"]["classifier_label"] = "Essentia Discogs-400"
  data["meta"]["silhouette"] = round(sil_2d, 3)
  data["meta"]["silhouette_feature"] = round(sil_hybrid, 3)
  data["meta"]["style_groups"] = style_groups
  data["meta"]["track_map"] = new_track_map
  data["meta"]["track_near"] = new_track_near

  out_text = (
      "// Auto-generated Essentia Discogs-400 + MTG-Jamendo corpus & UMAP map data.\n"
      + "window.CORPUS_DATA = "
      + json.dumps(data, separators=(",", ":"), ensure_ascii=False)
      + ";\n"
  )
  with open(out_js_path, "w", encoding="utf-8") as f:
    f.write(out_text)

  print(f"Wrote {out_js_path} ({os.path.getsize(out_js_path)/1e6:.2f} MB)")
  print(f"Silhouette: UMAP-2D={sil_2d:.3f}, Hybrid-Cosine={sil_hybrid:.3f}")
  print(f"Coords min/max: x=[{coords[:,0].min():.4f}, {coords[:,0].max():.4f}], y=[{coords[:,1].min():.4f}, {coords[:,1].max():.4f}]")
  print("\n=== 10 Canonical Style Clusters ===")
  for cidx in range(10):
    slot = slot_by_idx[cidx]
    mem = np.where(cluster_idx == cidx)[0]
    sc = Counter(format_discogs_style(str(dg_cls[int(np.argmax(discogs_mean[j]))])) for j in mem)
    mc = Counter(str(md_cls[int(np.argmax(mood_mean[j]))]) for j in mem)
    ic = Counter(str(in_cls[int(np.argmax(inst_mean[j]))]) for j in mem)
    top_s = ", ".join(f"{k} ({v})" for k, v in sc.most_common(3))
    top_m = ", ".join(f"{k} ({v})" for k, v in mc.most_common(2))
    top_i = ", ".join(f"{k} ({v})" for k, v in ic.most_common(2))
    print(f"  [{cidx}] {slot['id']:17s} n={len(mem):3d} | Styles: {top_s} | Moods: {top_m} | Inst: {top_i}")


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-js", default=DEFAULT_DATA_JS)
  parser.add_argument("--features", default=DEFAULT_FEATURES)
  parser.add_argument("--out", default=DEFAULT_OUT_JS)
  args = parser.parse_args()
  build_dataset(args.data_js, args.features, args.out)


if __name__ == "__main__":
  main()

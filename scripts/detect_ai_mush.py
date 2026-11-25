#!/usr/bin/env python3
"""Self-referenced 3-signal DSP detector for Suno / AI tail degradation ('mush').

Analyzes active `is_ai` tracks (>= 35s) against each track's own clean opening
reference (`5s..min(35s, 0.35 * duration)`), combining three orthogonal Suno
tail-degradation signatures across sliding 1-second windows:
  1. Spectral flatness & 4-11 kHz high-band noise-wash jump (vs 100-2200 Hz)
     plus sub-band spectral valley fill-in (spectral contrast drop),
  2. Margin-separated HPSS isotropic residual jump & transient crest collapse,
  3. Chroma tonal entropy spike (loss of pitch center into broadband smear).

Anti-false-positive rule (sustained tail persistence):
  Only flags `has_mush = true` when the composite mush score crosses threshold
  at `mush_onset_sec >= max(30.0, 0.38 * duration)` (`>= 10s` before actual
  end-of-track fadeout) AND stays elevated across the remaining active tail
  without recovering back into clean music.
"""

import argparse
import concurrent.futures
import json
import math
import os
import subprocess
import tempfile
import time
import urllib.request

import librosa
import numpy as np
from scipy.ndimage import uniform_filter1d

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TMP_ROOT = os.environ.get("SWARM_TMP_ROOT") or tempfile.gettempdir()
DEFAULT_DATA_JS = os.path.join(_ROOT, "js", "data.js")
DEFAULT_OUT_JSON = os.path.join(_ROOT, "scripts", "ai_mush_tags.json")
DEFAULT_CACHE_DIR = os.path.join(_TMP_ROOT, "mush_audio_cache")
DEFAULT_FEATURES_CACHE = os.path.join(_TMP_ROOT, "mush_features_cache.json")

SR = 22050
N_FFT = 2048
HOP = 512  # ~23.22 ms per STFT frame (~43.07 fps)
MIN_TRACK_DUR_SEC = 35.0
MIN_TAIL_SEC = 10.0

_FREQS = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)
_B_LOW = (_FREQS >= 100.0) & (_FREQS < 2200.0)
_B_MIDHIGH = (_FREQS >= 1800.0) & (_FREQS <= 10500.0)
_B_HIGH = (_FREQS >= 4000.0) & (_FREQS <= 10800.0)
_CONTRAST_MASKS = [
    (_FREQS >= f0) & (_FREQS < f1)
    for f0, f1 in (
        (200.0, 400.0),
        (400.0, 800.0),
        (800.0, 1600.0),
        (1600.0, 3200.0),
        (3200.0, 6400.0),
        (6400.0, 10800.0),
    )
]


def load_ai_tracks_from_data_js(data_js_path):
  raw = open(data_js_path, "r", encoding="utf-8").read()
  prefix = "window.CORPUS_DATA = "
  s = raw[raw.index(prefix) + len(prefix) :].rstrip()
  if s.endswith(";"):
    s = s[:-1]
  data = json.loads(s)
  return [t for t in data.get("tracks", []) if t.get("is_ai")]


def ensure_local_audio(track, cache_dir):
  tid = str(track["id"])
  for ext in (".m4a", ".mp3", ".wav", ".flac"):
    cand = os.path.join(cache_dir, tid + ext)
    if os.path.exists(cand) and os.path.getsize(cand) > 10000:
      return cand
  os.makedirs(cache_dir, exist_ok=True)
  url = track.get("stream_url") or track.get("mp3_320_url") or track.get("mp3_url")
  if not url:
    raise RuntimeError(f"No audio URL found for AI track {tid}")
  ext = ".m4a" if ".m4a" in url else ".mp3"
  dest = os.path.join(cache_dir, tid + ext)
  req = urllib.request.Request(url, headers={"User-Agent": "music-map-mush-dsp/1.0"})
  with urllib.request.urlopen(req, timeout=60) as resp:
    blob = resp.read()
  tmp = dest + ".part"
  with open(tmp, "wb") as f:
    f.write(blob)
  os.replace(tmp, dest)
  return dest


def decode_mono_f32(path, sr=SR):
  cmd = [
      "/usr/bin/ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      str(sr),
      "-f",
      "f32le",
      "-",
  ]
  raw = subprocess.check_output(cmd)
  return np.frombuffer(raw, dtype=np.float32)


def extract_track_features(args_tuple):
  track, cache_dir = args_tuple
  tid = str(track["id"])
  path = ensure_local_audio(track, cache_dir)
  y = decode_mono_f32(path, SR)
  dur = float(len(y)) / SR
  if dur < MIN_TRACK_DUR_SEC:
    return {
        "id": tid,
        "title": track.get("title", tid),
        "sub": track.get("ai_sub_label") or track.get("cluster_label") or "",
        "dur": round(dur, 2),
        "skipped_short": True,
    }

  S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP)) + 1e-10
  P_spec = S * S
  n_frames = S.shape[1]
  fps = SR / HOP

  # Signal 2a: Margin=2.0 HPSS separates clean horizontal harmonics (H) and crisp
  # vertical drum transients (P) from smeared isotropic phase-vocoder mush (Residual).
  S_harm, S_perc = librosa.decompose.hpss(S, kernel_size=(21, 21), margin=2.0)
  E_tot = np.sum(P_spec, axis=0) + 1e-12
  E_harm = np.sum(S_harm * S_harm, axis=0)
  E_perc = np.sum(S_perc * S_perc, axis=0)
  resid_share_f = np.clip(1.0 - (E_harm + E_perc) / E_tot, 0.0, 1.0)

  rms_f = np.sqrt(np.mean(P_spec, axis=0))
  rms_db_f = 20.0 * np.log10(np.maximum(rms_f, 1e-8))

  # Signal 1a: Mid-high [1.8 - 10.5 kHz] spectral flatness (Suno metallic hiss/wash)
  P_mh = P_spec[_B_MIDHIGH, :]
  flat_mh_f = np.exp(np.mean(np.log(P_mh + 1e-18), axis=0)) / (
      np.mean(P_mh, axis=0) + 1e-18
  )

  # Signal 1b: High-band [4.0 - 10.8 kHz] vs low-mid [100 - 2200 Hz] energy ratio (dB)
  E_low_f = np.sum(P_spec[_B_LOW, :], axis=0) + 1e-15
  E_high_f = np.sum(P_spec[_B_HIGH, :], axis=0) + 1e-15
  hi_lo_db_f = 10.0 * np.log10(E_high_f / E_low_f)

  # Signal 1c: Sub-band spectral contrast (peak - valley dB across 6 octave bands)
  S_db = 20.0 * np.log10(S)
  sc_bands = []
  for cm in _CONTRAST_MASKS:
    sub = S_db[cm, :]
    sc_bands.append(np.percentile(sub, 85, axis=0) - np.percentile(sub, 15, axis=0))
  spec_contrast_f = np.mean(sc_bands, axis=0)

  # Signal 2b: Onset strength envelope for transient sharpness crest factor
  onset_env = librosa.onset.onset_strength(
      S=librosa.power_to_db(P_spec), sr=SR, hop_length=HOP
  )

  # Signal 3: 12-bin chroma distribution for tonal pitch-center entropy
  chroma = librosa.feature.chroma_stft(S=P_spec, sr=SR, hop_length=HOP)

  n_sec = int(dur)
  sec_rms_db = np.zeros(n_sec, dtype=np.float64)
  sec_flat = np.zeros(n_sec, dtype=np.float64)
  sec_hilo = np.zeros(n_sec, dtype=np.float64)
  sec_resid = np.zeros(n_sec, dtype=np.float64)
  sec_contrast = np.zeros(n_sec, dtype=np.float64)
  sec_crest = np.zeros(n_sec, dtype=np.float64)
  sec_chroma_ent = np.zeros(n_sec, dtype=np.float64)

  for s in range(n_sec):
    f0 = max(0, int((s - 0.5) * fps))
    f1 = min(n_frames, int((s + 1.5) * fps))
    if f1 <= f0:
      f0 = max(0, int(s * fps))
      f1 = min(n_frames, int((s + 1) * fps))
    sec_rms_db[s] = float(np.median(rms_db_f[f0:f1]))
    sec_flat[s] = float(np.median(flat_mh_f[f0:f1]))
    sec_hilo[s] = float(np.median(hi_lo_db_f[f0:f1]))
    sec_resid[s] = float(np.median(resid_share_f[f0:f1]))
    sec_contrast[s] = float(np.median(spec_contrast_f[f0:f1]))
    oe = onset_env[f0:f1]
    med_oe = float(np.median(oe))
    p92_oe = float(np.percentile(oe, 92))
    sec_crest[s] = (p92_oe - med_oe) / (med_oe + 0.35)
    ch_win = np.mean(chroma[:, f0:f1], axis=1)
    ch_p = ch_win / (np.sum(ch_win) + 1e-12)
    sec_chroma_ent[s] = float(
        -np.sum(ch_p * np.log(ch_p + 1e-12)) / math.log(12.0)
    )

  return {
      "id": tid,
      "title": track.get("title", tid),
      "sub": track.get("ai_sub_label") or track.get("cluster_label") or "",
      "dur": round(dur, 2),
      "skipped_short": False,
      "rms_db": [round(float(x), 4) for x in sec_rms_db],
      "flat": [round(float(x), 5) for x in sec_flat],
      "hilo": [round(float(x), 4) for x in sec_hilo],
      "resid": [round(float(x), 5) for x in sec_resid],
      "contrast": [round(float(x), 4) for x in sec_contrast],
      "crest": [round(float(x), 4) for x in sec_crest],
      "chroma_ent": [round(float(x), 5) for x in sec_chroma_ent],
  }


def score_track_mush(feat):
  if feat.get("skipped_short"):
    return {
        "id": feat["id"],
        "title": feat["title"],
        "dur": feat["dur"],
        "has_mush": False,
        "mush_onset_sec": None,
        "mush_score": 0.0,
        "reason": "short_clip",
    }

  dur = float(feat["dur"])
  n_sec = len(feat["rms_db"])
  rms_db = np.array(feat["rms_db"], dtype=np.float64)
  flat = np.array(feat["flat"], dtype=np.float64)
  hilo = np.array(feat["hilo"], dtype=np.float64)
  resid = np.array(feat["resid"], dtype=np.float64)
  contrast = np.array(feat["contrast"], dtype=np.float64)
  crest = np.array(feat["crest"], dtype=np.float64)
  chroma_ent = np.array(feat["chroma_ent"], dtype=np.float64)

  # Active (non-fadeout, non-breakdown-silence) energy mask anchored to body loudness
  body_rms = float(
      np.percentile(rms_db[min(5, n_sec - 1) : max(10, int(0.85 * n_sec))], 65)
  )
  active_floor_db = max(-42.0, body_rms - 12.0)
  active_mask = rms_db >= active_floor_db
  active_indices = np.where(active_mask)[0]
  if len(active_indices) < 25:
    return {
        "id": feat["id"],
        "title": feat["title"],
        "dur": dur,
        "has_mush": False,
        "mush_onset_sec": None,
        "mush_score": 0.0,
        "reason": "sparse_energy",
    }

  active_end_sec = int(active_indices[-1]) + 1

  # 1. Clean opening reference: 5.0s .. min(35.0s, 0.35 * active_end_sec)
  r1 = max(16, min(35, int(round(0.35 * active_end_sec))))
  open_idx = np.where(
      (rms_db >= max(-42.0, body_rms - 16.0))
      & (np.arange(n_sec) >= 5)
      & (np.arange(n_sec) < r1)
  )[0]
  if len(open_idx) < 6:
    open_idx = active_indices[:12]

  # 2. Clean-drop baseline adjustment: if 5..35s was a quiet/filtered intro AND the track
  # subsequently drops into a clean rhythmic groove (higher transient crest & clean HPSS
  # residual < 0.48 within the first half), blend that clean groove into the baseline so
  # filter-open drops ("Acid cumbia 01 (4)", "After 1'30'' waow", "AI Afrohouse Modulates")
  # anchor to their clean full arrangement rather than false-triggering on hi-hat entry!
  early_body_cand = np.where(
      (rms_db >= body_rms - 4.5)
      & (np.arange(n_sec) >= r1)
      & (np.arange(n_sec) < int(0.54 * active_end_sec))
  )[0][:26]
  has_clean_drop = (
      len(early_body_cand) >= 8
      and float(np.median(resid[early_body_cand])) < 0.47
      and float(np.median(resid[early_body_cand])) <= float(np.median(resid[open_idx])) + 0.24
      and (
          float(np.median(crest[early_body_cand]))
          >= float(np.median(crest[open_idx])) * 1.25
          or float(np.median(rms_db[open_idx])) < body_rms - 5.0
      )
  )
  if has_clean_drop:
    ref_body = early_body_cand
    w_open, w_body = 0.25, 0.75
  else:
    ref_body = open_idx
    w_open, w_body = 1.0, 0.0

  def ref_stat(arr, q=50):
    return w_open * float(np.percentile(arr[open_idx], q)) + w_body * float(
        np.percentile(arr[ref_body], q)
    )

  # Signal 1: Spectral flatness & 4-11 kHz high-band wash jump + sub-band valley fill-in
  flat_base = max(ref_stat(flat, 55), 0.82 * float(np.median(flat[ref_body])))
  hilo_base = max(ref_stat(hilo, 55), float(np.median(hilo[ref_body])) - 2.0)
  cont_base = min(ref_stat(contrast, 50), float(np.median(contrast[ref_body])) + 1.2)

  d_flat = np.log2((flat + 0.015) / (flat_base + 0.015)) / 0.58
  d_hilo = (hilo - hilo_base) / 4.2
  d_valley = (cont_base - contrast) / 1.9
  sig1_spectral = (
      0.38 * np.clip(d_flat, -0.25, 4.0)
      + 0.32 * np.clip(d_hilo, -0.25, 4.0)
      + 0.30 * np.clip(d_valley, -0.35, 4.0)
  )

  # Signal 2: Margin-2.0 HPSS isotropic mush residual surge + transient sharpness collapse
  # Also check early full-body drum groove (5..min(65s, 0.44*end)) for tracks with pad intro -> drum drop -> mush
  early_drum_idx = np.where(
      (rms_db >= body_rms - 5.5)
      & (np.arange(n_sec) >= 5)
      & (np.arange(n_sec) < max(r1, min(70, int(0.42 * active_end_sec))))
  )[0]
  crest_capped = np.minimum(crest, 2.6)
  crest_base = float(np.median(crest_capped[open_idx]))
  if len(early_drum_idx) >= 8:
    crest_base = max(crest_base, 0.88 * float(np.percentile(crest_capped[early_drum_idx], 65)))

  if crest_base >= 0.65:
    d_crest = ((crest_base - crest_capped) / max(0.65, crest_base)) / 0.30
  else:
    d_crest = np.zeros_like(crest)

  resid_base = ref_stat(resid, 50)
  d_resid_abs = (resid - resid_base) / 0.08
  d_resid_rel = np.log2((resid + 0.05) / (resid_base + 0.05)) / 0.52
  d_resid = 0.60 * d_resid_abs + 0.40 * d_resid_rel
  high_resid_bonus = np.clip((resid - 0.55) / 0.12, 0.0, 2.2)

  sig2_clarity_drop = (
      0.50 * np.clip(d_resid, -1.0, 4.5)
      + 0.16 * high_resid_bonus
      + 0.34 * np.clip(d_crest, -1.2, 4.0)
  )

  # Signal 3: Chroma tonal entropy smear (discounted when crisp drums crest >= 2.0 drive broadband percussion)
  cent_base = min(ref_stat(chroma_ent, 50), float(np.median(chroma_ent[ref_body])) + 0.01)
  perc_discount = np.where(crest >= 2.0, 0.35, 1.0)
  sig3_tonal_smear = np.clip(((chroma_ent - cent_base) / 0.026) * perc_discount, -0.5, 3.5)

  # Combine Flavor A (spectral high-band wash + clarity loss) and Flavor B (severe HPSS + transient soup)
  combo_a = 0.42 * sig1_spectral + 0.44 * sig2_clarity_drop + 0.14 * sig3_tonal_smear
  combo_b = (
      0.72 * sig2_clarity_drop
      + 0.18 * np.maximum(0.0, sig1_spectral)
      + 0.10 * np.maximum(0.0, sig3_tonal_smear)
  )
  raw_score = np.maximum(combo_a, combo_b)

  # Crisp-percussion safeguard: on rhythmic tracks (crest_base >= 1.1), frames that maintain
  # crisp drums (crest >= max(2.0, crest_base * 0.88)) with non-extreme HPSS residual (< 0.64)
  # are genuine rhythmic drops (e.g. 'Epic droppp', 'Djembe Chord Prog'), not Suno mush
  crisp_drum_frame = (
      (crest_base >= 1.1)
      & (crest >= max(2.0, crest_base * 0.88))
      & (resid < 0.64)
  )
  raw_score_masked = np.where(active_mask & (~crisp_drum_frame), raw_score, 0.0)
  smooth_score = uniform_filter1d(raw_score_masked, size=7, mode="nearest")

  min_tail = max(15, int(round(0.12 * dur)))
  search_start = max(30, int(math.ceil(0.38 * dur)))
  latest_onset = min(active_end_sec - min_tail, int(math.floor(dur - min_tail)))

  best_onset = None
  tail_mean = 0.0
  tail_frac_high = 0.0
  end_third_mean = 0.0
  s1_tail = 0.0
  s2_tail = 0.0
  s3_tail = 0.0

  if latest_onset >= search_start:
    for t_cand in range(search_start, latest_onset + 1):
      if not active_mask[t_cand] or smooth_score[t_cand] < 0.98:
        continue
      tail_slice = np.arange(t_cand, active_end_sec)
      tail_act = tail_slice[active_mask[tail_slice]]
      if len(tail_act) < 12:
        continue
      t_scores = smooth_score[tail_act]
      t_mean = float(np.mean(t_scores))
      t_frac = float(np.mean(t_scores >= 0.82))
      last_third = tail_act[max(0, int(len(tail_act) * 0.65)) :]
      t_end_mean = float(np.mean(smooth_score[last_third]))

      # Anti-recovery check: if ANY 10s active window in the remaining tail recovers back
      # into clean music (< 0.45) or crisp drums, this was a breakdown/riser, NOT terminal mush!
      recovered = False
      if len(tail_act) >= 12:
        for k in range(0, max(1, len(tail_act) - 9)):
          win_idx = tail_act[k : k + 10]
          if float(np.mean(smooth_score[win_idx])) < 0.45 or float(np.mean(crisp_drum_frame[win_idx])) >= 0.5:
            recovered = True
            break
      if recovered:
        continue

      # Knee alignment: if the next 12s is still moderate (< 1.05) while the remaining tail
      # jumps meaningfully higher (> +0.35), step forward to the true degradation knee
      if (
          len(tail_act) >= 28
          and float(np.mean(t_scores[:12])) < 1.05
          and float(np.mean(t_scores[14:])) > float(np.mean(t_scores[:12])) + 0.35
      ):
        continue

      m1 = float(np.mean(sig1_spectral[tail_act]))
      m2 = float(np.mean(sig2_clarity_drop[tail_act]))
      m3 = float(np.mean(sig3_tonal_smear[tail_act]))
      tail_resid_med = float(np.median(resid[tail_act]))
      # Flavor A: spectral high-band wash + clarity loss; Flavor B: true isotropic HPSS soup (resid >= 0.56)
      flavor_a_ok = m1 >= 0.38 and m2 >= 0.40
      flavor_b_ok = m2 >= 1.35 and tail_resid_med >= 0.56
      if (
          t_mean >= 1.15
          and t_frac >= 0.80
          and t_end_mean >= 0.96
          and (flavor_a_ok or flavor_b_ok)
      ):
        best_onset = float(t_cand)
        tail_mean = t_mean
        tail_frac_high = t_frac
        end_third_mean = t_end_mean
        s1_tail, s2_tail, s3_tail = m1, m2, m3
        break

  diag_tail_slice = (
      np.arange(search_start, active_end_sec)
      if active_end_sec > search_start
      else np.array([], dtype=int)
  )
  diag_act = (
      diag_tail_slice[active_mask[diag_tail_slice]]
      if len(diag_tail_slice)
      else np.array([], dtype=int)
  )
  last25_act = diag_act[-min(25, len(diag_act)) :] if len(diag_act) else np.array([], dtype=int)
  diag_last25_score = float(np.mean(smooth_score[last25_act])) if len(last25_act) else 0.0

  return {
      "id": feat["id"],
      "title": feat["title"],
      "sub": feat.get("sub", ""),
      "dur": dur,
      "active_end_sec": active_end_sec,
      "has_mush": best_onset is not None,
      "mush_onset_sec": round(best_onset, 1) if best_onset is not None else None,
      "mush_score": round(tail_mean if best_onset is not None else diag_last25_score, 3),
      "tail_persist_frac": round(tail_frac_high, 3),
      "end_third_score": round(end_third_mean, 3),
      "sig1_spectral": round(
          s1_tail
          if best_onset is not None
          else (float(np.mean(sig1_spectral[last25_act])) if len(last25_act) else 0.0),
          3,
      ),
      "sig2_clarity_drop": round(
          s2_tail
          if best_onset is not None
          else (float(np.mean(sig2_clarity_drop[last25_act])) if len(last25_act) else 0.0),
          3,
      ),
      "sig3_tonal_smear": round(
          s3_tail
          if best_onset is not None
          else (float(np.mean(sig3_tonal_smear[last25_act])) if len(last25_act) else 0.0),
          3,
      ),
  }


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--data-js", default=DEFAULT_DATA_JS)
  parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
  parser.add_argument("--features-cache", default=DEFAULT_FEATURES_CACHE)
  parser.add_argument("--out", default=DEFAULT_OUT_JSON)
  parser.add_argument("--diagnostics-out", default="")
  parser.add_argument("--workers", type=int, default=12)
  args = parser.parse_args()

  t0 = time.time()
  ai_tracks = load_ai_tracks_from_data_js(args.data_js)

  cached_feats = {}
  if args.features_cache and os.path.exists(args.features_cache):
    try:
      for item in json.load(open(args.features_cache, "r", encoding="utf-8")):
        if isinstance(item, dict) and item.get("id"):
          cached_feats[str(item["id"])] = item
    except Exception:
      cached_feats = {}

  todo = [t for t in ai_tracks if str(t["id"]) not in cached_feats]
  if todo:
    print(f"Extracting 3-signal STFT/HPSS/Chroma features for {len(todo)} AI tracks ({args.workers} workers)...")
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as ex:
      for feat in ex.map(extract_track_features, [(t, args.cache_dir) for t in todo]):
        cached_feats[feat["id"]] = feat
    if args.features_cache:
      os.makedirs(os.path.dirname(args.features_cache), exist_ok=True)
      with open(args.features_cache, "w", encoding="utf-8") as f:
        json.dump(list(cached_feats.values()), f)

  scored = [score_track_mush(cached_feats[str(t["id"])]) for t in ai_tracks]
  flagged = [r for r in scored if r["has_mush"]]
  flagged.sort(key=lambda r: -r["mush_score"])

  tags_by_id = {}
  for r in scored:
    if r["has_mush"] and r["mush_onset_sec"] is not None:
      tags_by_id[r["id"]] = {
          "has_mush": True,
          "mush_onset_sec": r["mush_onset_sec"],
          "mush_score": r["mush_score"],
      }

  out_payload = {
      "schema": "ai-mush-v1",
      "analyzed_ai_tracks": len(ai_tracks),
      "eligible_full_tracks": sum(1 for r in scored if r.get("reason") != "short_clip"),
      "flagged_count": len(flagged),
      "tracks": tags_by_id,
  }
  os.makedirs(os.path.dirname(args.out), exist_ok=True)
  with open(args.out, "w", encoding="utf-8") as f:
    json.dump(out_payload, f, indent=2, sort_keys=False)
    f.write("\n")

  if args.diagnostics_out:
    os.makedirs(os.path.dirname(args.diagnostics_out), exist_ok=True)
    with open(args.diagnostics_out, "w", encoding="utf-8") as f:
      json.dump(sorted(scored, key=lambda r: -r["mush_score"]), f, indent=2)

  print(
      f"Done in {time.time() - t0:.1f}s: {len(flagged)}/{out_payload['eligible_full_tracks']} "
      f"full-length AI tracks flagged (`has_mush: true`) -> {args.out}"
  )
  print("\n=== Top Flagged AI Mush Tracks ===")
  for r in flagged[:35]:
    pct = round(100.0 * r["mush_onset_sec"] / max(1.0, r["dur"]))
    print(
        f"  {r['id']:20s} | onset={r['mush_onset_sec']:5.1f}s / {r['dur']:5.1f}s ({pct:2d}%) "
        f"| score={r['mush_score']:5.2f} (s1={r['sig1_spectral']:+.2f} s2={r['sig2_clarity_drop']:+.2f} s3={r['sig3_tonal_smear']:+.2f}) "
        f"| {r['title']}"
    )


if __name__ == "__main__":
  main()

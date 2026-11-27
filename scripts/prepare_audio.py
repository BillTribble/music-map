#!/usr/bin/env python3
"""Encode curated corpus + archive tracks to Beat-1 MP3 loops and build audio_manifest.json.

By default, existing audio/*.mp3 files are preserved byte-identical (skip re-encoding
unless --force or --track-id is passed) so incremental uploads only transmit new clips.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import unicodedata
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "audio"
MANIFEST_PATH = ROOT / "scripts" / "audio_manifest.json"

# Tuple: (source_kind, era_id, slot, title, default_bpm, rel_path[, fixed_cue_sec])
TRACK_SPECS = [
    # ---- Phase 0: Pre-2013 Archive (Me Music Archive) ----
    ("archive", "present_ambient", 1, "1 Thing Led 2 Another", 110.0, "me archive/present trax/- present mp3s/ambient/1 thing led 2 another and b4 we knew it.mp3"),
    ("archive", "present_ambient", 2, "Sankhara 01", 96.0, "me archive/present trax/- present mp3s/ambient/sankhara 01.mp3"),
    ("archive", "present_ambient", 3, "Saying Only Small Things", 100.0, "me archive/present trax/- present mp3s/ambient/saying only small things that i know.mp3"),
    ("archive", "present_ambient", 4, "Do It Like a Robot", 104.0, "me archive/present trax/- present mp3s/ambient/do it like a robot.mp3"),

    ("archive", "present_electro", 1, "Disco Queen (C64)", 128.0, "me archive/present trax/- present mp3s/highlights/disco queen c64 version.mp3"),
    ("archive", "present_electro", 2, "UFO (People U Can Relax With)", 126.0, "me archive/present trax/- present mp3s/highlights/ufo (people u can relax with even when you're not relaxed).mp3"),
    ("archive", "present_electro", 3, "Bethnal Green Sunset", 124.0, "me archive/present trax/- present mp3s/recent/bethnal green sunset.mp3"),
    ("archive", "present_electro", 4, "Lime Angel Delight", 122.0, "me archive/present trax/- present mp3s/mid tempo/Lime Angel Delight.mp3"),
    ("archive", "present_electro", 5, "As We Enter", 130.0, "me archive/present trax/- present mp3s/PR3S3NT/pr3s3nt  - As we Enter.mp3"),

    ("archive", "hd_2005", 1, "Orch Synaesthesia", 122.0, "me music - 2005 hard drive/Orch Synaesthesia.m4a"),
    ("archive", "hd_2005", 2, "Sine Mix 01", 125.0, "me music - 2005 hard drive/sine mix 01.m4a"),
    ("archive", "hd_2005", 3, "Junglemassive", 170.0, "me music - 2005 hard drive/junglemassive.m4a"),
    ("archive", "hd_2005", 4, "White Morning", 120.0, "me music - 2005 hard drive/White Morning Mixdown 03.m4a"),

    ("archive", "bands_archive", 5, "Spudboy — Drone 2 Static", 92.0, "Spudboy/drone 2 static C Maj.mp3"),
    ("archive", "bands_archive", 6, "Make It Thru", 124.0, "me archive/2014/make it thru.mp3"),

    # ---- Phase 1–4: Main 2013–2026 Corpus ----
    ("corpus", "archive_2013_18", 1, "808 Bomb", 136.0, "Archive me music 2013-18/808 bomb 15.mp3"),
    ("corpus", "archive_2013_18", 2, "Alchemy 30", 120.0, "Archive me music 2013-18/Alchemy 30.mp3"),
    ("corpus", "archive_2013_18", 3, "Acid Avenger 01", 128.0, "Archive me music 2013-18/Acid Avenger 01.mp3"),
    ("corpus", "archive_2013_18", 4, "Italo", 122.0, "Archive me music 2013-18/Italo.mp3"),

    ("corpus", "nihon_forever", 1, "04 Cicada Overlords", 120.0, "^ Released - Albums, EPs/01 - Nihon Forever/share(hifi) 2018/04 Cicada Overlords.mp3"),
    ("corpus", "nihon_forever", 2, "07 Funabashi Massive", 120.0, "^ Released - Albums, EPs/01 - Nihon Forever/share(hifi) 2018/07 Funabashi Massive.mp3"),
    ("corpus", "nihon_forever", 3, "01 Korogi Song", 120.0, "^ Released - Albums, EPs/01 - Nihon Forever/share(hifi) 2018/01 Korogi Song.mp3"),
    ("corpus", "nihon_forever", 4, "03 Shibuya Flyover", 125.0, "^ Released - Albums, EPs/01 - Nihon Forever/share(hifi) 2018/03 Shibuya Flyover.mp3"),

    ("corpus", "ep_concepts", 1, "Deep Insight (Arising & Passing)", 120.0, "05 - EP concepts/Arising and Passing - high energy EP/02 Deep insight into the arising and passing.flac"),
    ("corpus", "ep_concepts", 2, "Underground Forest (JI 808)", 137.0, "05 - EP concepts/Le Garage era tracks 2018 and before/Underground forest 20.mp3"),
    ("corpus", "ep_concepts", 3, "06 Olga", 95.0, "05 - EP concepts/Dark ambient EP/06 olga master 02 2023-09-21 2217.wav"),
    ("corpus", "ep_concepts", 4, "TempleGong City", 130.0, "05 - EP concepts/Le Garage era tracks 2018 and before/TempleGong City 08.mp3"),

    ("corpus", "le_garage", 1, "01 Le Garage Hermétique", 137.0, "^ Released - Albums, EPs/02 - Le Garage Hermétique/exports - Garage Hermétique/^ final album mastered/Le Garage master 2023 FLAC. Smashed -10lufs/Le Garage Hermetique flac/01 Le Garage Hermétique.flac"),
    ("corpus", "le_garage", 2, "08 Sacred Songs of Chiram (Semaradana)", 120.0, "^ Released - Albums, EPs/02 - Le Garage Hermétique/exports - Garage Hermétique/^ final album mastered/Le Garage master 2023 FLAC. Smashed -10lufs/Le Garage Hermetique flac/08 Sacred songs of Chiram.flac"),
    ("corpus", "le_garage", 3, "03 Tar'Hai Bells", 124.0, "^ Released - Albums, EPs/02 - Le Garage Hermétique/exports - Garage Hermétique/^ final album mastered/Le Garage master 2023 FLAC. Smashed -10lufs/Le Garage Hermetique flac/03 Tar'Hai Bells.flac"),
    ("corpus", "le_garage", 4, "07 Major Grubert's Enlightenment", 122.0, "^ Released - Albums, EPs/02 - Le Garage Hermétique/exports - Garage Hermétique/^ final album mastered/Le Garage master 2023 FLAC. Smashed -10lufs/Le Garage Hermetique flac/07 Major Grubert's enlightenment.flac"),

    ("corpus", "psychedailies", 1, "25 Fireworks", 176.78, "02 - Psychedailies/Season 1 - psychedaily/^ SHORTLIST psychedailies/- 25 Fireworks! Great vox sample and sax D&B/fireworks edit 01 2023-06-09 1815.flac"),
    ("corpus", "psychedailies", 2, "03 Incantation", 141.97, "02 - Psychedailies/Season 1 - psychedaily/03/03 - Incantation.mp3"),
    ("corpus", "psychedailies", 3, "26 Fell in Love", 172.0, "02 - Psychedailies/Season 1 - psychedaily/^ SHORTLIST psychedailies/- 26 Fell in love - nice vox D&B/26 Fell in love.mp3"),
    ("corpus", "psychedailies", 4, "05 Summon", 110.0, "02 - Psychedailies/Season 1 - psychedaily/^ SHORTLIST psychedailies/- 05 Summon downtempo/05 Project/05.mp3"),

    ("corpus", "archive_2018_23", 1, "Blood in My Veins", 120.0, "Archive me music 2018-23/03 - Vocal EP/blood in my veins Project/Bill Tribble - blood in my veins.wav"),
    ("corpus", "archive_2018_23", 2, "FF33 Utopia", 148.0, "Archive me music 2018-23/03 - Vocal EP/FF33b Project/FF33b 01-.mp3"),
    ("corpus", "archive_2018_23", 3, "Who Are We", 124.0, "Archive me music 2018-23/03 - Vocal EP/who are we 01 Project/who are we 07 stereo + kick.flac"),

    ("corpus", "spirit_guides", 1, "01 Call to Adventure", 73.0, "^ Released - Albums, EPs/03 - Spirit Guides - ambient album/^ Exports - Spirit Guides ambient album/Mastered to -15LUFS - Spirit Guides album/01 Call to adventure.wav"),
    ("corpus", "spirit_guides", 2, "03 Voice of the Spirits", 109.0, "^ Released - Albums, EPs/03 - Spirit Guides - ambient album/^ Exports - Spirit Guides ambient album/Mastered to -15LUFS - Spirit Guides album/03 Voice of the spirits.wav"),
    ("corpus", "spirit_guides", 3, "02 Forest of Mysteries", 92.0, "^ Released - Albums, EPs/03 - Spirit Guides - ambient album/^ Exports - Spirit Guides ambient album/Mastered to -15LUFS - Spirit Guides album/02 Forest of mysteries.wav"),
    ("corpus", "spirit_guides", 4, "05 Dark Night of the Soul", 86.0, "^ Released - Albums, EPs/03 - Spirit Guides - ambient album/^ Exports - Spirit Guides ambient album/Mastered to -15LUFS - Spirit Guides album/05 Dark night of the soul.wav"),

    ("corpus", "lucid_crystal", 1, "01 Crystal Temple Opening Ritual", 120.0, "^ Released - Albums, EPs/04 - Lucid Crystal Temple/^ exports - Lucid Crystal/Lucid crystal temple - flac/01 Crystal Temple Opening Ritual - remaster 01.flac"),
    ("corpus", "lucid_crystal", 2, "03 Lightstone Cave", 83.0, "^ Released - Albums, EPs/04 - Lucid Crystal Temple/^ exports - Lucid Crystal/Lucid crystal temple - flac/03 Lightstone cave.flac"),
    ("corpus", "lucid_crystal", 3, "02 Chromacolor", 110.0, "^ Released - Albums, EPs/04 - Lucid Crystal Temple/^ exports - Lucid Crystal/Lucid crystal temple - flac/02 Chromacolor.flac"),
    ("corpus", "lucid_crystal", 4, "04 Procession of Eternal Gratitude", 96.0, "^ Released - Albums, EPs/04 - Lucid Crystal Temple/^ exports - Lucid Crystal/Lucid crystal temple - flac/04 The Procession of Eternal Gratitude.flac"),

    ("corpus", "remixes_commissions", 1, "Serpentine (Remix)", 174.0, "^ remixes and commissions/Starseed soul Elena - Serpentine/Serpentine remix 10 revert drums 2024-03-24 2146.flac"),
    ("corpus", "remixes_commissions", 2, "Arc 110 (Remix)", 110.0, "^ remixes and commissions/Jake - Arc 110/arc 110 remix 04 2025-02-28 1848.flac"),
    ("corpus", "remixes_commissions", 3, "Te Vaka — Tatao (Remix)", 120.0, "^ remixes and commissions/Te Vaka - Tatao edit/tatao 01/tatao 18 clap 2023-06-16 1620.flac"),

    ("corpus", "sketches_2024_25", 1, "Granular Perc (Gamelanish)", 120.0, "^ music sketches 2024/granular perc fun/granular perc fun gamelanish.mp3"),
    ("corpus", "sketches_2024_25", 2, "Shepard Tone 02", 131.0, "^ music sketches 2025/shepard tone 01 Project/shepard tone 02.flac"),
    ("corpus", "sketches_2024_25", 3, "Afro Retro", 122.0, "^ music sketches 2025/afro retro/afro retro 2025-01-06 2349.mp3"),
    ("corpus", "sketches_2024_25", 4, "Techno Idea 02", 130.0, "^ music sketches 2025/techno idea 01/techno idea 02 2025-03-19 1300.flac"),

    ("corpus", "ecstatic_wave", 1, "Flowing Wave (Preview)", 88.64, "06 - Ecstatic Wave Album/^ export/Flowing wave 27.flac", 1369.0),
    ("corpus", "ecstatic_wave", 2, "Mega Dark Bass", 122.0, "06 - Ecstatic Wave Album/Mega dark bass/Matchered/Bill Tribble - Mega dark bass 06 matchered.flac"),
    ("corpus", "ecstatic_wave", 3, "Afro 06", 122.0, "06 - Ecstatic Wave Album/^ export/Afro 06.flac"),
    ("corpus", "ecstatic_wave", 4, "Great Spirit 01", 122.0, "06 - Ecstatic Wave Album/^ export/Great spirit 01.flac"),

    ("corpus", "sketches_2026", 1, "Arcadian Sunrise 05", 110.0, "^ music sketches 2026/Arcadian sunrise/Arcadian sunrise 05 2026-03-22 0741_(Matched)hora dorado.flac"),
    ("corpus", "sketches_2026", 2, "Breath-Domi 05", 129.0, "^ music sketches 2026/breath-domi/breath-domi 05 2026-05-31 1147.flac"),
    ("corpus", "sketches_2026", 3, "Mya Moody Banger", 124.0, "^ music sketches 2026/mya moody banger 01b.mp3"),
    ("corpus", "sketches_2026", 4, "Journey Domi 03", 120.0, "^ music sketches 2026/Journey, kalimba, piano test/Ableton beat template/Journey domi 03 2026-03-29 1811.flac"),
]


def resolve_corpus_path(root: Path, rel_str: str) -> Path:
    cur = root
    for part in rel_str.split("/"):
        cand = cur / part
        if cand.exists():
            cur = cand
            continue
        target_nfc = unicodedata.normalize("NFC", part)
        matched = None
        if cur.exists():
            for child in cur.iterdir():
                if unicodedata.normalize("NFC", child.name) == target_nfc:
                    matched = child
                    break
        if matched is None:
            raise FileNotFoundError(f"Could not resolve segment {part!r} under {cur}")
        cur = matched
    return cur


def _gain_metrics(samples: np.ndarray) -> tuple[float, float]:
    hop = 40
    n_frames = len(samples) // hop
    if n_frames < 10:
        return -14.5, 1.0
    frames = samples[: n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    peak_rms = float(np.max(rms)) if len(rms) else 0.1
    active = rms[rms > peak_rms * 0.12]
    med_rms = float(np.median(active)) if len(active) else float(np.median(rms))
    rms_db = 20.0 * math.log10(max(1e-6, med_rms))
    est_lufs = rms_db - 0.7
    gain_db = max(-18.0, min(12.0, -16.5 - est_lufs))
    gain_trim = math.pow(10.0, gain_db / 20.0)
    return round(rms_db, 2), round(gain_trim, 4)


def analyze_source_groove(ffmpeg_bin: str, src_path: Path, bpm: float, fixed_cue: float | None = None) -> dict:
    """Decode source master to 8kHz mono PCM, find beat phase, Beat-1 groove cue, and RMS gain trim."""
    beat_sec = 60.0 / bpm
    bar_sec = 4.0 * beat_sec
    if fixed_cue is not None:
        win_start = max(0.0, fixed_cue - 4.0)
        r = subprocess.run(
            [ffmpeg_bin, "-v", "error", "-ss", f"{win_start:.4f}", "-t", "60", "-i", str(src_path), "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
            capture_output=True,
            check=True,
        )
        samples = np.frombuffer(r.stdout, dtype=np.float32)
        rms_db, gain_trim = _gain_metrics(samples)
        return {
            "full_duration_sec": float(fixed_cue) + 120.0,
            "beat_sec": round(beat_sec, 5),
            "bar_sec": round(bar_sec, 5),
            "source_cue_sec": float(fixed_cue),
            "rms_db": rms_db,
            "gain_trim": gain_trim,
        }

    r = subprocess.run(
        [ffmpeg_bin, "-v", "error", "-i", str(src_path), "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    )
    samples = np.frombuffer(r.stdout, dtype=np.float32)
    sr = 8000.0
    dur_sec = float(len(samples)) / sr

    hop = 40  # 5 ms envelope -> 200 Hz
    env_sr = sr / hop
    n_frames = len(samples) // hop
    if n_frames < 400:
        return {
            "full_duration_sec": dur_sec,
            "beat_sec": round(beat_sec, 5),
            "bar_sec": round(bar_sec, 5),
            "source_cue_sec": 0.0,
            "rms_db": -14.5,
            "gain_trim": 1.0,
        }

    frames = samples[: n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    flux = np.maximum(0.0, np.diff(rms, prepend=rms[0]))
    flux_smooth = 0.5 * np.roll(flux, 1) + flux + 0.5 * np.roll(flux, -1)

    t_start = dur_sec * 0.10
    t_end = dur_sec * 0.90
    best_phase = 0.0
    best_score = -1.0
    for phase in np.linspace(0.0, beat_sec, 60, endpoint=False):
        k_min = int(math.ceil((t_start - phase) / beat_sec))
        k_max = int(math.floor((t_end - phase) / beat_sec))
        if k_max <= k_min:
            continue
        idxs = np.clip(np.round((phase + np.arange(k_min, k_max + 1) * beat_sec) * env_sr).astype(int), 0, n_frames - 1)
        score = float(np.mean(flux_smooth[idxs]))
        if score > best_score:
            best_score = score
            best_phase = float(phase)

    b_scores = []
    for b_off in range(4):
        k_min = int(math.ceil((t_start - best_phase) / beat_sec))
        k_max = int(math.floor((t_end - best_phase) / beat_sec))
        ks = np.arange(k_min, k_max + 1)
        ks_b = ks[(ks % 4) == b_off]
        if len(ks_b) == 0:
            b_scores.append(0.0)
        else:
            idxs = np.clip(np.round((best_phase + ks_b * beat_sec) * env_sr).astype(int), 0, n_frames - 1)
            b_scores.append(float(np.mean(flux_smooth[idxs])))
    downbeat_off = int(np.argmax(b_scores))

    win_lo = max(bar_sec * 2.0, dur_sec * 0.12)
    win_hi = min(dur_sec - bar_sec * 10.0, dur_sec * 0.58)
    if win_hi <= win_lo:
        win_lo = min(bar_sec, dur_sec * 0.08)
        win_hi = max(win_lo + 1.0, dur_sec - bar_sec * 4.0)

    k_start_idx = int(math.ceil((win_lo - best_phase - downbeat_off * beat_sec) / bar_sec))
    k_end_idx = int(math.floor((win_hi - best_phase - downbeat_off * beat_sec) / bar_sec))
    best_cue = win_lo
    best_cue_score = -1.0

    global_med_flux = max(1e-6, float(np.percentile(flux_smooth, 85)))
    for m in range(max(0, k_start_idx), max(max(0, k_start_idx) + 1, k_end_idx + 1)):
        c_sec = best_phase + (downbeat_off + 4 * m) * beat_sec
        if c_sec < 0.0 or c_sec + 4.0 * bar_sec >= dur_sec:
            continue
        f0 = int(round(c_sec * env_sr))
        f1 = min(n_frames, int(round((c_sec + 4.0 * bar_sec) * env_sr)))
        if f1 <= f0 + 10:
            continue
        seg_rms = float(np.mean(rms[f0:f1]))
        db_idxs = [min(n_frames - 1, int(round((c_sec + b * bar_sec) * env_sr))) for b in range(4)]
        db_flux = float(np.mean(flux_smooth[db_idxs]))
        norm_flux = min(2.0, db_flux / global_med_flux)
        sc = seg_rms * (0.5 + norm_flux)
        if sc > best_cue_score:
            best_cue_score = sc
            best_cue = float(c_sec)

    rms_db, gain_trim = _gain_metrics(samples)
    return {
        "full_duration_sec": dur_sec,
        "beat_sec": round(beat_sec, 5),
        "bar_sec": round(bar_sec, 5),
        "source_cue_sec": best_cue,
        "rms_db": rms_db,
        "gain_trim": gain_trim,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", required=True)
    parser.add_argument("--archive-root", required=True)
    parser.add_argument("--bpm-json", default=None, help="Optional JSON mapping track_id -> analyzed BPM")
    parser.add_argument("--quality", type=int, default=6, help="LAME VBR quality (-q:a) for newly encoded clips")
    parser.add_argument("--new-bars", type=int, default=8, help="Bar length for newly encoded clips (default 8)")
    parser.add_argument("--track-id", default=None)
    parser.add_argument("--force", action="store_true", help="Re-encode even when audio/*.mp3 already exists")
    args = parser.parse_args()

    corpus_root = Path(args.corpus_root).expanduser()
    archive_root = Path(args.archive_root).expanduser()
    if not corpus_root.exists():
        raise SystemExit(f"Corpus root not found: {corpus_root}")
    if not archive_root.exists():
        raise SystemExit(f"Archive root not found: {archive_root}")

    bpm_overrides = {}
    if args.bpm_json and Path(args.bpm_json).exists():
        bpm_overrides = json.loads(Path(args.bpm_json).read_text(encoding="utf-8"))

    ffmpeg_bin = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    if not Path(ffmpeg_bin).exists():
        raise SystemExit("ffmpeg not found")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    existing_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    existing_by_id = {
        e["id"]: e
        for lst in existing_manifest.get("tracks_by_era", {}).values()
        for e in lst
    }
    tracks_by_era: dict[str, list[dict]] = {}

    for spec in TRACK_SPECS:
        src_kind, era, slot, title, default_bpm, rel, *rest = spec
        fixed_cue = float(rest[0]) if rest else None
        tid = f"{era}_{slot}"
        out_name = f"{tid}.mp3"
        dst = AUDIO_DIR / out_name

        # Preserve existing MP3s untouched unless explicitly requested (--force or matching --track-id)
        if dst.exists() and not args.force and (args.track_id is None or args.track_id != tid):
            prev = existing_by_id.get(tid)
            if prev:
                entry = dict(prev)
                entry["source"] = src_kind
                tracks_by_era.setdefault(era, []).append(entry)
                continue

        if args.track_id and tid != args.track_id and tid in existing_by_id:
            entry = dict(existing_by_id[tid])
            entry["source"] = src_kind
            tracks_by_era.setdefault(era, []).append(entry)
            continue

        bpm = float(bpm_overrides.get(tid, default_bpm))
        root_dir = archive_root if src_kind == "archive" else corpus_root
        src = resolve_corpus_path(root_dir, rel)
        groove = analyze_source_groove(ffmpeg_bin, src, bpm, fixed_cue=fixed_cue)
        bar_sec = groove["bar_sec"]
        beat_sec = groove["beat_sec"]
        full_dur_sec = groove["full_duration_sec"]
        source_cue_sec = groove["source_cue_sec"]

        clip_bars = args.new_bars
        if clip_bars * bar_sec > 30.0:
            clip_bars = 4
        clip_dur_sec = clip_bars * bar_sec
        if source_cue_sec + clip_dur_sec > full_dur_sec - 0.1:
            while source_cue_sec - bar_sec >= 0.0 and source_cue_sec + clip_dur_sec > full_dur_sec - 0.1:
                source_cue_sec -= bar_sec
            if source_cue_sec + clip_dur_sec > full_dur_sec - 0.1:
                clip_bars = min(clip_bars, max(4, int((full_dur_sec - 0.1) // bar_sec)))
                clip_dur_sec = clip_bars * bar_sec
                source_cue_sec = max(0.0, min(source_cue_sec, max(0.0, full_dur_sec - clip_dur_sec - 0.05)))

        fade_out_st = max(0.05, clip_dur_sec - 0.025)
        cmd = [
            ffmpeg_bin, "-y", "-v", "error",
            "-ss", f"{source_cue_sec:.4f}",
            "-t", f"{clip_dur_sec:.4f}",
            "-i", str(src),
            "-map", "0:a:0", "-vn",
            "-af", f"afade=t=in:st=0:d=0.012,afade=t=out:st={fade_out_st:.4f}:d=0.025",
            "-ar", "44100", "-ac", "2",
            "-codec:a", "libmp3lame", "-q:a", str(args.quality),
            str(dst),
        ]
        subprocess.run(cmd, check=True)
        sz = dst.stat().st_size

        entry = {
            "id": tid,
            "slot": slot,
            "source": src_kind,
            "title": title,
            "bpm": round(bpm, 2),
            "file": f"audio/{out_name}",
            "bytes": sz,
            "duration_sec": round(clip_dur_sec, 3),
            "clip_bars": clip_bars,
            "beat_sec": beat_sec,
            "bar_sec": bar_sec,
            "beat_phase_sec": 0.0,
            "cue_sec": 0.0,
            "rms_db": groove["rms_db"],
            "gain_trim": groove["gain_trim"],
        }
        tracks_by_era.setdefault(era, []).append(entry)
        print(
            f"[OK] {out_name:28s} | {sz/1024:6.1f} KB | {clip_bars:2d}b ({clip_dur_sec:5.1f}s) "
            f"| {bpm:6.2f} BPM | src_cue={source_cue_sec:6.2f}s | gain={groove['gain_trim']:.2f}"
        )

    for era in tracks_by_era:
        tracks_by_era[era].sort(key=lambda e: e["slot"])

    total_bytes = sum(e["bytes"] for lst in tracks_by_era.values() for e in lst)
    manifest = {
        "n_tracks": sum(len(v) for v in tracks_by_era.values()),
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / 1048576, 2),
        "tracks_by_era": tracks_by_era,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nWrote {MANIFEST_PATH} | Total MP3 size: {manifest['total_mb']:.2f} MB ({manifest['n_tracks']} tracks)")


if __name__ == "__main__":
    main()

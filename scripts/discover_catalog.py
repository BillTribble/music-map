#!/usr/bin/env python3
"""Complete catalog discovery, hard exclusions, deduplication & metadata registry.

Scans --archive-root and --corpus-root (or an rclone remote specified via
--rclone-remote / MUSIC_ARCHIVE_REMOTE) across all 17 source groups, applies
strict exclusions, deduplicates versions, matches official releases via
release_catalog.py, and writes catalog_manifest.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import release_catalog as rc  # noqa: E402

AUDIO_EXTS = {".flac", ".wav", ".aif", ".aiff", ".mp3", ".m4a", ".ogg", ".aac"}
LOSSLESS_EXTS = {".flac", ".wav", ".aif", ".aiff"}
EXT_RANK = {".flac": 7, ".wav": 6, ".aif": 5, ".aiff": 5, ".m4a": 3, ".mp3": 2, ".aac": 2, ".ogg": 1}
MIN_BYTES = 50 * 1024

EXCLUDED_BAND_RE = re.compile(r"\b(clor|infants|real\s+feal|feal\s+real)\b", re.IGNORECASE)
EXCLUDED_ZOMBIES_RE = re.compile(r"\bzombies\b", re.IGNORECASE)
EXCLUDED_TITLE_RE = re.compile(r"^claudia(?:\s+poem)?$", re.IGNORECASE)
EXCLUDED_DIR_NAMES = {
    "samples",
    "backup",
    "ableton project info",
    "presets",
    "stems",
    "recordings",
    "rifffs",
    "field recordings + more",
    "template",
    "templates",
    "library",
    "^ export medicine set 2023",
    "dj mixes",
    "reference tracks mastering",
    "woodlands contributions",
    "uridium",
    "guitar sketches",
}
EXCLUDED_PATH_SUBSTRS = (
    "jomtones rules",
    "takes all sorts mix",
    "buy one get one free mix",
    "casa mix",
    "reference tracks mastering",
    "afro house clouds",
    "seventh afrohouse",
    "wrong pitch!",
    "infants - first jam",
    "00 live samsara bitwig/recordings",
    "^ export medicine set 2023",
    "diva-house",
    "09 woodlands - ut 1",
    "subtropic",
    "03 kiosk - track 3",
    "dj arry",
    "selling_demo",
    "urid-samples",
    "afrobeat drums and amapiano bass",
    "luca singing accidents happen",
    "pansexual ritual",
    "metally riff",
    "pavementish",
    "take it back vox idea",
)
EXCLUDED_FILE_TOKENS = ("stem", "backing", "drumloop")
EXCLUDED_EXACT_FILES = {"bass.wav", "vocals.wav", "perc.wav", "other.wav"}
SKETCH_FOLDER_MARKERS = ("^ music sketches", "rc505 looper sketches", "2019 sketches", "guitar sketches")
SKETCH_WORD_RE = re.compile(r"\b(sketch|ruff|idea|test|demo|loop)\b", re.IGNORECASE)
ALT_ARRANGEMENT_RE = re.compile(
    r"\((c64|human|acoustic|live|dub|instrumental|vox|vocal|ambient|semeradana)\)"
    r"|\b(duality\s*[12]\s*(?:minor|major)|c64\s+version)\b",
    re.IGNORECASE,
)

# (source_kind, path_prefix_lower, era_id, default_year, is_sketch_source)
SOURCE_GROUPS = [
    ("archive", "me archive/present trax", "present_ambient", 2003, False),
    ("archive", "me music - 2005 hard drive", "hd_2005", 2005, False),
    ("archive", "me archive/2014", "bands_archive", 2014, False),
    ("archive", "spudboy", "bands_archive", 2009, False),
    ("archive", "yon", "bands_archive", 2008, False),
    ("archive", "my own band", "bands_archive", 2008, False),
    ("archive", "psykers", "bands_archive", 2008, False),
    ("archive", "^ jams + rc505 looper sketches", "archive_2018_23", 2020, True),
    ("corpus", "^ released - albums, eps", "le_garage", 2023, False),
    ("corpus", "archive me music 2013-18", "archive_2013_18", 2016, False),
    ("corpus", "archive me music 2018-23", "archive_2018_23", 2020, False),
    ("corpus", "02 - psychedailies", "psychedailies", 2021, False),
    ("corpus", "05 - ep concepts", "ep_concepts", 2019, False),
    ("corpus", "06 - ecstatic wave album", "ecstatic_wave", 2025, False),
    ("corpus", "ai music 2025", "sketches_2024_25", 2025, True),
    ("corpus", "^ music sketches 2024", "sketches_2024_25", 2024, True),
    ("corpus", "^ music sketches 2025", "sketches_2024_25", 2025, True),
    ("corpus", "^ music sketches 2026", "sketches_2026", 2026, True),
    ("corpus", "^ remixes and commissions", "remixes_commissions", 2023, False),
]


def norm_nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def slugify(text: str) -> str:
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s[:72] or "track"


def classify_era_and_year(src_kind: str, rel_path: str, mtime_year: int | None) -> tuple[str, int, bool]:
    low = norm_nfc(rel_path).lower()
    if src_kind == "archive":
        if low.startswith("me archive/present trax"):
            era = "present_ambient" if "/ambient/" in low else "present_electro"
            return era, 2003, False
        if low.startswith("me music - 2005 hard drive"):
            return "hd_2005", 2005, False
        if low.startswith("me archive/2014"):
            return "bands_archive", 2014, False
        if low.startswith(("spudboy", "yon", "my own band", "psykers")):
            return "bands_archive", 2008, False
        if low.startswith("^ jams + rc505 looper sketches"):
            return "archive_2018_23", 2020, True
        return "bands_archive", min(mtime_year or 2012, 2014), False

    # Corpus groups
    if low.startswith("^ released - albums, eps"):
        if "nihon forever" in low:
            return "nihon_forever", 2018, False
        if "le garage" in low:
            return "le_garage", 2023, False
        if "spirit guides" in low:
            return "spirit_guides", 2025, False
        if "lucid crystal" in low:
            return "lucid_crystal", 2026, False
    if low.startswith("archive me music 2013-18"):
        # Parse explicit year from path/filename, fallback to file mtime
        ym = re.findall(r"\b(201[3-8])\b", low)
        yr = int(ym[-1]) if ym else (mtime_year if mtime_year and 2012 <= mtime_year <= 2018 else 2016)
        return "archive_2013_18", yr, any(m in low for m in SKETCH_FOLDER_MARKERS)
    if low.startswith("archive me music 2018-23"):
        ym = re.findall(r"\b(201[89]|202[0-3])\b", low)
        yr = int(ym[-1]) if ym else (mtime_year if mtime_year and 2018 <= mtime_year <= 2023 else 2020)
        return "archive_2018_23", yr, any(m in low for m in SKETCH_FOLDER_MARKERS)
    if low.startswith("02 - psychedailies"):
        return "psychedailies", 2021, False
    if low.startswith("05 - ep concepts"):
        yr = 2018 if "2018 and before" in low else 2021
        return "ep_concepts", yr, any(m in low for m in SKETCH_FOLDER_MARKERS)
    if low.startswith("06 - ecstatic wave album"):
        return "ecstatic_wave", 2025, False
    if low.startswith("ai music 2025"):
        return "sketches_2024_25", 2025, True
    if low.startswith("^ music sketches 2024"):
        return "sketches_2024_25", 2024, True
    if low.startswith("^ music sketches 2025"):
        return "sketches_2024_25", 2025, True
    if low.startswith("^ music sketches 2026"):
        return "sketches_2026", 2026, True
    if low.startswith("^ remixes and commissions"):
        ym = re.findall(r"\b(202[0-6])\b", low)
        yr = int(ym[-1]) if ym else (mtime_year or 2023)
        return "remixes_commissions", yr, False
    return "archive_2018_23", mtime_year or 2020, False


def is_in_scope(src_kind: str, rel_path: str) -> bool:
    low = norm_nfc(rel_path).lower()
    return any(sk == src_kind and low.startswith(prefix) for sk, prefix, *_ in SOURCE_GROUPS)


def is_excluded(rel_path: str, size_bytes: int, dirs_with_top_render: set[str]) -> str | None:
    if size_bytes < MIN_BYTES:
        return "tiny_file"
    low = norm_nfc(rel_path).lower()
    parts = [p for p in low.split("/") if p]
    if not parts:
        return "empty_path"
    fname = parts[-1]
    ext = Path(fname).suffix.lower()
    if ext not in AUDIO_EXTS:
        return "non_audio"
    if fname in EXCLUDED_EXACT_FILES:
        return "split_stem"
    if EXCLUDED_BAND_RE.search(low):
        return "excluded_band"
    if EXCLUDED_ZOMBIES_RE.search(low):
        return "excluded_zombies"
    if EXCLUDED_TITLE_RE.match(Path(fname).stem.strip()):
        return "excluded_claudia"
    for sub in EXCLUDED_PATH_SUBSTRS:
        if sub in low:
            return f"excluded_path:{sub}"
    parent_parts = parts[:-1]
    for p in parent_parts:
        if p in EXCLUDED_DIR_NAMES:
            return f"excluded_dir:{p}"
    if "bounce" in parent_parts:
        b_idx = parent_parts.index("bounce")
        parent_dir = "/".join(parent_parts[:b_idx])
        if parent_dir in dirs_with_top_render:
            return "bounce_redundant"
    stem = Path(fname).stem.lower()
    for tok in EXCLUDED_FILE_TOKENS:
        if re.search(rf"(?:^|[^a-z]){re.escape(tok)}(?:$|[^a-z])", stem):
            return f"excluded_token:{tok}"
    return None


def normalize_song_key(rel_path: str) -> str:
    """Normalize a track filename/stem into a canonical deduplication key."""
    stem = Path(norm_nfc(rel_path)).stem
    alt_tags = [m.group(0).lower().strip("() ") for m in ALT_ARRANGEMENT_RE.finditer(stem)]
    s = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"^(?:bill\s+tribble\s*[-_–]+\s*|pr3s3nt\s*[-_–]+\s*)", "", s)
    s = re.sub(r"_\(matched\).*$", "", s)
    s = re.sub(r"\(\s*\d+\s*\)$", "", s)
    s = re.sub(r"\b20\d{2}[-_]\d{2}[-_]\d{2}(?:\s+\d{4})?\b", " ", s)
    s = re.sub(
        r"\b(?:re?master(?:ed)?|master(?:ed)?|matchered|matched|hifi|lofi|ruff\s*mix|rough\s*mix|mixdown|comp|final|smashed|edit|stereo\s*\+\s*kick)\b",
        " ",
        s,
    )
    s = re.sub(r"\s*[-_]+\s*(?:10|12|15)\s*lufs\b", " ", s)
    s = re.sub(r"\s*[-_]+\s*(?:12|15)\b\s*$", " ", s)
    s = re.sub(r"^\d{1,3}\s*[-._]+\s*", "", s)
    s = re.sub(r"\s+\d{1,3}[a-z]?\s*$", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    if alt_tags:
        s = f"{s}__alt_{'_'.join(sorted(set(alt_tags)))}"
    # Scope by top-level era family so identically numbered sketches don't collide across years
    top = norm_nfc(rel_path).lower().split("/", 1)[0]
    return f"{top}::{s or stem.lower()}"


def clean_title(rel_path: str) -> str:
    stem = Path(norm_nfc(rel_path)).stem
    t = re.sub(r"^(?:Bill\s+Tribble\s*[-–]+\s*)", "", stem, flags=re.IGNORECASE)
    t = re.sub(r"_\(Matched\).*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+20\d{2}-\d{2}-\d{2}(?:\s+\d{4})?$", "", t)
    t = re.sub(r"\s+-\s+remaster\s+\d+$", "", t, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", t).strip() or stem


def version_rank(rel_path: str, size_bytes: int) -> tuple:
    low = norm_nfc(rel_path).lower()
    ext = Path(low).suffix
    is_released_dir = 1 if low.startswith("^ released - albums, eps") else 0
    is_final_master = 1 if any(k in low for k in ("master", "matched", "final", "remaster")) else 0
    take_nums = [int(n) for n in re.findall(r"\b(\d{1,3})\b", Path(low).stem) if int(n) < 1900]
    max_take = max(take_nums) if take_nums else 0
    return (is_released_dir, is_final_master, EXT_RANK.get(ext, 0), max_take, size_bytes)


def probe_duration(ffprobe_bin: str | None, path: Path) -> float | None:
    if not ffprobe_bin or not path.exists():
        return None
    try:
        res = subprocess.run(
            [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            return round(float(res.stdout.strip()), 2)
    except Exception:
        pass
    return None


def scan_local_tree(root: Path, src_kind: str) -> list[dict]:
    items = []
    if not root.exists():
        return items
    for dirpath, _, filenames in os.walk(root):
        dp = Path(dirpath)
        rel_dir = norm_nfc(str(dp.relative_to(root))) if dp != root else ""
        for fn in filenames:
            fp = dp / fn
            rel = f"{rel_dir}/{fn}" if rel_dir else fn
            if not is_in_scope(src_kind, rel):
                continue
            try:
                st = fp.stat()
            except OSError:
                continue
            import datetime
            mtime_yr = datetime.datetime.fromtimestamp(st.st_mtime).year
            items.append({
                "src_kind": src_kind,
                "rel_path": norm_nfc(rel),
                "local_path": str(fp),
                "size_bytes": st.st_size,
                "mtime_year": mtime_yr,
            })
    return items


def scan_rclone_tree(rclone_bin: str, remote_path: str, src_kind: str) -> list[dict]:
    cmd = [rclone_bin, "lsjson", "-R", "--files-only", remote_path]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    rows = json.loads(res.stdout)
    items = []
    for row in rows:
        rel = norm_nfc(str(row.get("Path", "")))
        if not is_in_scope(src_kind, rel):
            continue
        mt = str(row.get("ModTime", ""))[:4]
        mtime_yr = int(mt) if mt.isdigit() else None
        items.append({
            "src_kind": src_kind,
            "rel_path": rel,
            "remote_path": f"{remote_path}/{rel}",
            "size_bytes": int(row.get("Size", 0)),
            "mtime_year": mtime_yr,
        })
    return items


def build_manifest(raw_items: list[dict], ffprobe_bin: str | None = None, check_duration: bool = False) -> dict:
    # Pre-pass: find parent directories that have at least one top-level audio render (for bounce/ rule)
    dirs_with_top_render: set[str] = set()
    for it in raw_items:
        parts = norm_nfc(it["rel_path"]).lower().split("/")
        if len(parts) >= 2 and Path(parts[-1]).suffix.lower() in AUDIO_EXTS and it["size_bytes"] >= MIN_BYTES:
            if parts[-2] not in EXCLUDED_DIR_NAMES and parts[-2] != "bounce":
                dirs_with_top_render.add("/".join(parts[:-1]))

    excluded_counts: dict[str, int] = defaultdict(int)
    grouped: dict[str, list[dict]] = defaultdict(list)

    for it in raw_items:
        reason = is_excluded(it["rel_path"], it["size_bytes"], dirs_with_top_render)
        if reason:
            excluded_counts[reason] += 1
            continue
        key = normalize_song_key(it["rel_path"])
        grouped[key].append(it)

    era_counters: dict[str, int] = defaultdict(int)
    selected: list[dict] = []
    for key, candidates in sorted(grouped.items()):
        winner = max(candidates, key=lambda c: version_rank(c["rel_path"], c["size_bytes"]))
        era, year, folder_sketch = classify_era_and_year(winner["src_kind"], winner["rel_path"], winner.get("mtime_year"))
        era_counters[era] += 1
        slot = era_counters[era]
        digest = hashlib.sha1(f"{era}:{winner['rel_path']}".encode("utf-8")).hexdigest()[:6]
        tid = f"{era}_{slot}_{digest}"
        title = clean_title(winner["rel_path"])
        ext = Path(winner["rel_path"]).suffix.lower()
        has_lossless = ext in LOSSLESS_EXTS

        rel_match = rc.match_released_track(title, winner["rel_path"], era)
        released = rel_match is not None
        links = dict(rel_match["links"]) if rel_match else {}
        if rel_match:
            title = rel_match["title"]
            year = int(rel_match["year"])
            era = rel_match["era"]

        dur_sec = None
        if check_duration and winner.get("local_path"):
            dur_sec = probe_duration(ffprobe_bin, Path(winner["local_path"]))

        is_sketch = bool(
            (dur_sec is not None and dur_sec < 120.0)
            or (not released and (folder_sketch or SKETCH_WORD_RE.search(title) or SKETCH_WORD_RE.search(winner["rel_path"])))
        )
        tier = "released" if released else ("archive_dl" if year < 2015 else "request")

        selected.append({
            "id": tid,
            "era": era,
            "slot": slot,
            "source": winner["src_kind"],
            "title": title,
            "shortTitle": title.split(" (")[0][:26],
            "rel_path": winner["rel_path"],
            "local_path": winner.get("local_path", ""),
            "remote_path": winner.get("remote_path", ""),
            "ext": ext,
            "size_bytes": winner["size_bytes"],
            "full_duration_sec": dur_sec,
            "year": year,
            "has_lossless": has_lossless,
            "is_sketch": is_sketch,
            "released": released,
            "tier": tier,
            "links": links,
            "dedup_variants": len(candidates),
            "slug": slugify(title),
        })

    return {
        "n_raw_candidates": len(raw_items),
        "n_excluded": sum(excluded_counts.values()),
        "excluded_breakdown": dict(sorted(excluded_counts.items())),
        "n_tracks": len(selected),
        "tier_counts": {
            "released": sum(1 for t in selected if t["tier"] == "released"),
            "archive_dl": sum(1 for t in selected if t["tier"] == "archive_dl"),
            "request": sum(1 for t in selected if t["tier"] == "request"),
        },
        "tracks": selected,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Discover and deduplicate full music archive catalog.")
    ap.add_argument("--archive-root", default="", help="Local path to pre-2015 music archive root")
    ap.add_argument("--corpus-root", default="", help="Local path to main music projects corpus root")
    ap.add_argument("--rclone-remote", default=os.environ.get("MUSIC_ARCHIVE_REMOTE", ""), help="Optional rclone remote name (e.g. remote:)")
    ap.add_argument("--rclone-archive-dir", default="Music mp3s - Me music archive")
    ap.add_argument("--rclone-corpus-dir", default="AV music projects")
    ap.add_argument("--probe-durations", action="store_true", help="Run ffprobe on local files for full_duration_sec")
    ap.add_argument("--out", type=Path, default=SCRIPTS_DIR / "catalog_manifest.json")
    args = ap.parse_args()

    raw_items: list[dict] = []
    if args.archive_root or args.corpus_root:
        if args.archive_root:
            raw_items.extend(scan_local_tree(Path(args.archive_root).expanduser(), "archive"))
        if args.corpus_root:
            raw_items.extend(scan_local_tree(Path(args.corpus_root).expanduser(), "corpus"))
    elif args.rclone_remote:
        rclone_bin = shutil.which("rclone") or str(Path.home() / ".local" / "bin" / "rclone")
        rem = args.rclone_remote.rstrip(":/") + ":"
        raw_items.extend(scan_rclone_tree(rclone_bin, f"{rem}{args.rclone_archive_dir}", "archive"))
        raw_items.extend(scan_rclone_tree(rclone_bin, f"{rem}{args.rclone_corpus_dir}", "corpus"))
    else:
        ap.error("Provide --archive-root / --corpus-root or --rclone-remote (or MUSIC_ARCHIVE_REMOTE).")

    ffprobe_bin = shutil.which("ffprobe")
    manifest = build_manifest(raw_items, ffprobe_bin=ffprobe_bin, check_duration=args.probe_durations)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Catalog discovery complete -> {args.out}\n"
        f"  Raw candidates: {manifest['n_raw_candidates']} | Excluded: {manifest['n_excluded']} | "
        f"Deduplicated tracks: {manifest['n_tracks']}\n"
        f"  Tiers: {manifest['tier_counts']}"
    )


if __name__ == "__main__":
    main()

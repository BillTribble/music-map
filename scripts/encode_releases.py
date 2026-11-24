#!/usr/bin/env python3
"""Multi-threaded audio encoder & GitHub Release asset uploader.

Reads catalog_manifest.json and produces:
  1. Beat-aligned 8-bar 112 kbps MP3 preview clips -> audio/clips/<id>.mp3
  2. Pre-2015 full-length 320 kbps CBR MP3s -> Bill_Tribble_-_<slug>.mp3
  3. Pre-2015 lossless FLACs (strictly when has_lossless=True) -> Bill_Tribble_-_<slug>.flac

Uploads assets to GitHub Releases on BillTribble/music-map via `gh release`:
  - `audio-previews-v1` for preview clips (--upload-previews)
  - `archive-downloads-v1` (auto-sharding to -v2/-v3 if >900 assets) for full downloads
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
DEFAULT_REPO = "BillTribble/music-map"
MAX_ASSETS_PER_RELEASE = 900


def find_gh() -> str:
    return shutil.which("gh") or str(Path.home() / ".local" / "bin" / "gh")


def encode_preview_clip(
    ffmpeg_bin: str,
    src_path: Path,
    dst_path: Path,
    cue_sec: float = 0.0,
    dur_sec: float = 20.0,
    bitrate: str = "112k",
) -> int:
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    fade_out = max(0.05, dur_sec - 0.025)
    cmd = [
        ffmpeg_bin, "-y", "-v", "error",
        "-ss", f"{max(0.0, cue_sec):.3f}",
        "-t", f"{dur_sec:.3f}",
        "-i", str(src_path),
        "-map", "0:a:0", "-vn",
        "-af", f"afade=t=in:st=0:d=0.012,afade=t=out:st={fade_out:.3f}:d=0.025",
        "-ar", "44100", "-ac", "2",
        "-codec:a", "libmp3lame", "-b:a", bitrate,
        str(dst_path),
    ]
    subprocess.run(cmd, check=True)
    return dst_path.stat().st_size


def encode_full_mp3_320(ffmpeg_bin: str, src_path: Path, dst_path: Path, title: str) -> int:
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin, "-y", "-v", "error",
        "-i", str(src_path),
        "-map", "0:a:0", "-vn",
        "-codec:a", "libmp3lame", "-b:a", "320k",
        "-metadata", "artist=Bill Tribble",
        "-metadata", f"title={title}",
        str(dst_path),
    ]
    subprocess.run(cmd, check=True)
    return dst_path.stat().st_size


def encode_full_flac(ffmpeg_bin: str, src_path: Path, dst_path: Path, title: str) -> int:
    """Encode lossless source (.flac/.wav/.aif/.aiff) to level-8 FLAC. Never transcode lossy inputs."""
    if src_path.suffix.lower() not in {".flac", ".wav", ".aif", ".aiff"}:
        raise ValueError(f"Refusing to transcode lossy source to FLAC: {src_path}")
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin, "-y", "-v", "error",
        "-i", str(src_path),
        "-map", "0:a:0", "-vn",
        "-c:a", "flac", "-compression_level", "8",
        "-metadata", "artist=Bill Tribble",
        "-metadata", f"title={title}",
        str(dst_path),
    ]
    subprocess.run(cmd, check=True)
    return dst_path.stat().st_size


def ensure_release(gh_bin: str, repo: str, tag: str, title: str, notes: str) -> None:
    view = subprocess.run([gh_bin, "release", "view", tag, "-R", repo], capture_output=True, text=True, check=False)
    if view.returncode == 0:
        return
    subprocess.run(
        [gh_bin, "release", "create", tag, "-R", repo, "--title", title, "--notes", notes],
        check=True,
    )


def release_asset_count(gh_bin: str, repo: str, tag: str) -> int:
    res = subprocess.run(
        [gh_bin, "release", "view", tag, "-R", repo, "--json", "assets"],
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        return 0
    try:
        return len(json.loads(res.stdout).get("assets", []))
    except Exception:
        return 0


def upload_assets_batched(gh_bin: str, repo: str, tag: str, files: list[Path], batch_size: int = 25) -> None:
    for idx in range(0, len(files), batch_size):
        chunk = [str(p) for p in files[idx : idx + batch_size]]
        subprocess.run([gh_bin, "release", "upload", tag, *chunk, "-R", repo, "--clobber"], check=True)


def release_download_url(repo: str, tag: str, filename: str) -> str:
    return f"https://github.com/{repo}/releases/download/{tag}/{filename}"


def process_pre_2015_track(
    ffmpeg_bin: str,
    track: dict,
    out_dir: Path,
    repo: str,
    tag: str,
) -> dict:
    src = Path(track.get("local_path") or "")
    if not src.exists():
        return {"id": track["id"], "status": "missing_source"}

    slug = track["slug"]
    title = track["title"]
    mp3_name = f"Bill_Tribble_-_{slug}.mp3"
    mp3_path = out_dir / mp3_name
    mp3_bytes = mp3_path.stat().st_size if mp3_path.exists() else encode_full_mp3_320(ffmpeg_bin, src, mp3_path, title)

    result = {
        "id": track["id"],
        "status": "ok",
        "mp3_path": mp3_path,
        "mp3_320_bytes": mp3_bytes,
        "mp3_320_url": release_download_url(repo, tag, mp3_name),
        "flac_path": None,
        "flac_bytes": None,
        "flac_url": "",
    }
    if track.get("has_lossless"):
        flac_name = f"Bill_Tribble_-_{slug}.flac"
        flac_path = out_dir / flac_name
        flac_bytes = flac_path.stat().st_size if flac_path.exists() else encode_full_flac(ffmpeg_bin, src, flac_path, title)
        result["flac_path"] = flac_path
        result["flac_bytes"] = flac_bytes
        result["flac_url"] = release_download_url(repo, tag, flac_name)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description="Encode 320k MP3 + lossless FLACs & upload GitHub Release assets.")
    ap.add_argument("--manifest", type=Path, default=SCRIPTS_DIR / "catalog_manifest.json")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--archive-out", type=Path, default=Path("/tmp/music_map_archive_exports"))
    ap.add_argument("--previews-dir", type=Path, default=ROOT / "audio")
    ap.add_argument("--workers", type=int, default=min(16, os.cpu_count() or 4))
    ap.add_argument("--encode-archive", action="store_true", help="Encode Tier B (<2015) 320k MP3 + lossless FLAC")
    ap.add_argument("--upload-archive", action="store_true", help="Upload encoded Tier B assets to archive-downloads-v*")
    ap.add_argument("--upload-previews", action="store_true", help="Upload preview MP3s to audio-previews-v1")
    ap.add_argument("--preview-tag", default="audio-previews-v1")
    ap.add_argument("--archive-tag-prefix", default="archive-downloads")
    args = ap.parse_args()

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise SystemExit("ffmpeg not found on PATH")
    gh_bin = find_gh()

    if args.upload_previews:
        clips = sorted(args.previews_dir.glob("*.mp3"))
        if not clips:
            raise SystemExit(f"No preview MP3 files found in {args.previews_dir}")
        ensure_release(
            gh_bin,
            args.repo,
            args.preview_tag,
            "Audio Previews v1",
            "8-bar beat-aligned audio preview clips for Bill Tribble Music Map.",
        )
        upload_assets_batched(gh_bin, args.repo, args.preview_tag, clips)
        print(f"Uploaded {len(clips)} preview clips to {args.repo} release {args.preview_tag}")

    if not args.encode_archive and not args.upload_archive:
        return

    if not args.manifest.exists():
        raise SystemExit(f"Manifest not found: {args.manifest}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    tier_b = [t for t in manifest.get("tracks", []) if t.get("tier") == "archive_dl"]
    print(f"Found {len(tier_b)} Tier B (<2015) archive tracks in manifest")

    shard_idx = 1
    current_tag = f"{args.archive_tag_prefix}-v{shard_idx}"
    asset_count = release_asset_count(gh_bin, args.repo, current_tag) if args.upload_archive else 0
    upload_queue: dict[str, list[Path]] = {}
    by_id = {t["id"]: t for t in manifest.get("tracks", [])}

    if args.encode_archive:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = [
                pool.submit(process_pre_2015_track, ffmpeg_bin, t, args.archive_out, args.repo, current_tag)
                for t in tier_b
            ]
            for fut in as_completed(futs):
                res = fut.result()
                if res["status"] != "ok":
                    continue
                needed = 2 if res["flac_path"] else 1
                if args.upload_archive and asset_count + needed > MAX_ASSETS_PER_RELEASE:
                    shard_idx += 1
                    current_tag = f"{args.archive_tag_prefix}-v{shard_idx}"
                    asset_count = release_asset_count(gh_bin, args.repo, current_tag)
                    slug = by_id[res["id"]]["slug"]
                    res["mp3_320_url"] = release_download_url(args.repo, current_tag, f"Bill_Tribble_-_{slug}.mp3")
                    if res["flac_path"]:
                        res["flac_url"] = release_download_url(args.repo, current_tag, f"Bill_Tribble_-_{slug}.flac")
                asset_count += needed
                trk = by_id[res["id"]]
                trk["mp3_320_url"] = res["mp3_320_url"]
                trk["mp3_320_bytes"] = res["mp3_320_bytes"]
                if res["flac_path"]:
                    trk["flac_url"] = res["flac_url"]
                    trk["flac_bytes"] = res["flac_bytes"]
                trk["dl_ready"] = True
                upload_queue.setdefault(current_tag, []).append(res["mp3_path"])
                if res["flac_path"]:
                    upload_queue[current_tag].append(res["flac_path"])

        args.manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.upload_archive:
        for tag, files in upload_queue.items():
            ensure_release(
                gh_bin,
                args.repo,
                tag,
                f"Archive Downloads {tag.rsplit('-', 1)[-1]}",
                "Full-length 320 kbps MP3 and lossless FLAC pre-2015 archive releases.",
            )
            upload_assets_batched(gh_bin, args.repo, tag, files)
            print(f"Uploaded {len(files)} archive assets to {args.repo} release {tag}")


if __name__ == "__main__":
    main()

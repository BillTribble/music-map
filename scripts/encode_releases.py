#!/usr/bin/env python3
"""Multi-threaded audio encoder & GitHub Release asset uploader.

Reads catalog_manifest.json (and exclusions.json) and produces:
  1. Beat-aligned 8-bar 112 kbps MP3 preview clips -> audio/clips/<id>.mp3
  2. Pre-2015 full-length 320 kbps CBR MP3s -> Bill_Tribble_-_<slug>.mp3
  3. Pre-2015 lossless FLACs (strictly when has_lossless=True) -> Bill_Tribble_-_<slug>.flac
  4. Post-2015 lightweight full-length streaming encodes (Opus `.webm`, AAC `.m4a`, or MP3)
     from staged raw masters (`/tmp/swarm-1445092/newer_raw_audio/manifest.json`) -> `audio-streams-v1`,
     promoting full-track `peaks` + `preview_start_sec` + `stream_url` in `waveforms_and_cues.json`.

Uploads assets to GitHub Releases on BillTribble/music-map via `gh release`:
  - `audio-previews-v1` for preview clips (--upload-previews)
  - `archive-downloads-v1` (auto-sharding to -v2/-v3 if >900 assets) for full downloads
  - `audio-streams-v1` for newer (>=2015) streaming-tier tracks (--encode-streams --upload-streams)
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
DEFAULT_STAGING = Path.home() / "tmp" / "music_map_staging"
DEFAULT_NEWER_STAGE = Path("/tmp/swarm-1445092/newer_raw_audio")
MAX_ASSETS_PER_RELEASE = 900


def find_gh() -> str:
    return shutil.which("gh") or str(Path.home() / ".local" / "bin" / "gh")


def load_excluded_ids(exclusions_path: Path | None) -> set[str]:
    if exclusions_path and exclusions_path.exists():
        data = json.loads(exclusions_path.read_text(encoding="utf-8"))
        return set(data.get("excluded_ids", []))
    return set()


def load_calibration_only_ids(exclusions_path: Path | None) -> set[str]:
    if exclusions_path and exclusions_path.exists():
        data = json.loads(exclusions_path.read_text(encoding="utf-8"))
        return set(data.get("calibration_only_ids", []))
    return set()


def prune_excluded_release_assets(
    gh_bin: str,
    repo: str,
    excluded_ids: set[str],
    calibration_ids: set[str],
    archive_dl_path: Path,
    archive_tag: str = "archive-downloads-v1",
    preview_tag: str = "audio-previews-v1",
    stream_tag: str = "audio-streams-v1",
) -> None:
    dl = json.loads(archive_dl_path.read_text(encoding="utf-8")) if archive_dl_path.exists() else {}

    def _live_assets(tag: str) -> set[str]:
        r = subprocess.run([gh_bin, "release", "view", tag, "-R", repo, "--json", "assets"], capture_output=True, text=True)
        if r.returncode != 0:
            return set()
        return {a["name"] for a in json.loads(r.stdout).get("assets", [])}

    arch_live = _live_assets(archive_tag)
    prev_live = _live_assets(preview_tag)
    stream_live = _live_assets(stream_tag)

    to_delete: list[tuple[str, str]] = []
    for tid in sorted(excluded_ids):
        rec = dl.get(tid, {})
        for key in ("mp3_320_url", "flac_url"):
            u = rec.get(key) or ""
            if u:
                aname = u.rsplit("/", 1)[-1]
                if aname in arch_live:
                    to_delete.append((archive_tag, aname))
        if tid not in calibration_ids:
            pname = f"{tid}.mp3"
            if pname in prev_live:
                to_delete.append((preview_tag, pname))
        for ext in (".m4a", ".webm", ".mp3"):
            sname = f"{tid}{ext}"
            if sname in stream_live:
                to_delete.append((stream_tag, sname))

    if not to_delete:
        print("No excluded assets present on GitHub Releases.")
        return

    def _del_one(pair: tuple[str, str]) -> tuple[str, str, int]:
        tag, name = pair
        r = subprocess.run([gh_bin, "release", "delete-asset", tag, name, "-R", repo, "--yes"], capture_output=True, text=True)
        return tag, name, r.returncode

    with ThreadPoolExecutor(max_workers=8) as pool:
        for tag, name, rc in pool.map(_del_one, to_delete):
            print(f"Deleted {tag}/{name} (rc={rc})")


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


def stream_ext_for_codec(codec: str) -> str:
    c = codec.lower()
    if c == "opus":
        return ".webm"
    if c == "aac":
        return ".m4a"
    if c == "mp3":
        return ".mp3"
    raise ValueError(f"Unsupported stream codec: {codec!r} (choose opus, aac, or mp3)")


def atomic_write_text(dst: Path, text: str) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, dst)


def encode_stream_file(
    ffmpeg_bin: str,
    src_path: Path,
    dst_path: Path,
    codec: str = "aac",
    bitrate: str = "128k",
    lowpass_hz: int = 16500,
) -> int:
    """Encode a streaming-tier full track (AAC `.m4a` +faststart, Opus `.webm`, or MP3) with stripped metadata."""
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    c = codec.lower()
    cmd = [
        ffmpeg_bin, "-nostdin", "-y", "-v", "error",
        "-i", str(src_path),
        "-map", "0:a:0", "-vn",
        "-map_metadata", "-1",
    ]
    if lowpass_hz and lowpass_hz > 0:
        cmd += ["-af", f"lowpass=f={int(lowpass_hz)}"]
    if c == "opus":
        cmd += ["-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", str(dst_path)]
    elif c == "aac":
        cmd += ["-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", str(dst_path)]
    elif c == "mp3":
        cmd += ["-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", bitrate, str(dst_path)]
    else:
        raise ValueError(f"Unsupported stream codec: {codec!r}")
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


def upload_assets_batched(gh_bin: str, repo: str, tag: str, files: list[Path], batch_size: int = 20, parallel_batches: int = 4) -> None:
    chunks = [[str(p) for p in files[idx : idx + batch_size]] for idx in range(0, len(files), batch_size)]

    def _upload_chunk(chunk: list[str]) -> None:
        for attempt in range(3):
            res = subprocess.run([gh_bin, "release", "upload", tag, *chunk, "-R", repo, "--clobber"], capture_output=True, text=True)
            if res.returncode == 0:
                return
            if attempt == 2:
                raise subprocess.CalledProcessError(res.returncode, res.args, output=res.stdout, stderr=res.stderr)

    with ThreadPoolExecutor(max_workers=parallel_batches) as pool:
        futs = [pool.submit(_upload_chunk, ch) for ch in chunks]
        for fut in as_completed(futs):
            fut.result()


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


def process_staged_stream_track(
    ffmpeg_bin: str,
    item: dict,
    out_dir: Path,
    repo: str,
    tag: str,
    codec: str,
    bitrate: str,
    lowpass_hz: int,
) -> dict:
    tid = item["id"]
    src = Path(item.get("staged_path") or "")
    if not src.exists():
        return {"id": tid, "status": "missing_source"}
    ext = stream_ext_for_codec(codec)
    fname = f"{tid}{ext}"
    dst = out_dir / fname
    sz = dst.stat().st_size if (dst.exists() and dst.stat().st_size > 1024) else encode_stream_file(
        ffmpeg_bin, src, dst, codec=codec, bitrate=bitrate, lowpass_hz=lowpass_hz
    )
    return {
        "id": tid,
        "status": "ok",
        "path": dst,
        "bytes": sz,
        "stream_url": release_download_url(repo, tag, fname),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Encode 320k MP3, lossless FLACs & newer streams + upload GitHub Release assets.")
    ap.add_argument("--manifest", type=Path, default=SCRIPTS_DIR / "catalog_manifest.json")
    ap.add_argument("--exclusions", type=Path, default=DEFAULT_STAGING / "exclusions.json")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--archive-out", type=Path, default=Path("/tmp/music_map_archive_exports"))
    ap.add_argument("--streams-out", type=Path, default=Path("/tmp/swarm-1445092/stream_exports"))
    ap.add_argument("--newer-stage-dir", type=Path, default=DEFAULT_NEWER_STAGE)
    ap.add_argument("--waveforms-json", type=Path, default=DEFAULT_STAGING / "waveforms_and_cues.json")
    ap.add_argument("--previews-dir", type=Path, default=ROOT / "audio")
    ap.add_argument("--workers", type=int, default=min(32, os.cpu_count() or 8))
    ap.add_argument("--encode-archive", action="store_true", help="Encode Tier B (<2015) 320k MP3 + lossless FLAC")
    ap.add_argument("--upload-archive", action="store_true", help="Upload encoded Tier B assets to archive-downloads-v*")
    ap.add_argument("--upload-previews", action="store_true", help="Upload preview MP3s to audio-previews-v1")
    ap.add_argument("--encode-streams", action="store_true", help="Encode staged >=2015 newer tracks for streaming")
    ap.add_argument("--upload-streams", action="store_true", help="Upload encoded newer streams to audio-streams-v1 & update waveforms_and_cues.json")
    ap.add_argument("--prune-excluded", action="store_true", help="Delete excluded assets from GitHub Releases")
    ap.add_argument("--archive-dl-json", type=Path, default=DEFAULT_STAGING / "archive_dl_results.json")
    ap.add_argument("--stream-codec", default="aac", choices=["opus", "aac", "mp3"])
    ap.add_argument("--stream-bitrate", default="128k")
    ap.add_argument("--stream-lowpass", type=int, default=16500, help="Low-pass cutoff in Hz (0 disables)")
    ap.add_argument("--stream-tag", default="audio-streams-v1")
    ap.add_argument("--preview-tag", default="audio-previews-v1")
    ap.add_argument("--archive-tag-prefix", default="archive-downloads")
    args = ap.parse_args()

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise SystemExit("ffmpeg not found on PATH")
    gh_bin = find_gh()
    excluded_ids = load_excluded_ids(args.exclusions)
    calibration_ids = load_calibration_only_ids(args.exclusions)

    if args.prune_excluded:
        prune_excluded_release_assets(
            gh_bin=gh_bin,
            repo=args.repo,
            excluded_ids=excluded_ids,
            calibration_ids=calibration_ids,
            archive_dl_path=args.archive_dl_json,
            archive_tag=f"{args.archive_tag_prefix}-v1",
            preview_tag=args.preview_tag,
            stream_tag=args.stream_tag,
        )

    if args.upload_previews:
        clips = [p for p in sorted(args.previews_dir.glob("*.mp3")) if p.stem not in excluded_ids]
        if not clips:
            raise SystemExit(f"No non-excluded preview MP3 files found in {args.previews_dir}")
        ensure_release(
            gh_bin,
            args.repo,
            args.preview_tag,
            "Audio Previews v1",
            "8-bar beat-aligned audio preview clips for Bill Tribble Music Map.",
        )
        upload_assets_batched(gh_bin, args.repo, args.preview_tag, clips)
        print(f"Uploaded {len(clips)} preview clips to {args.repo} release {args.preview_tag}")

    if args.encode_streams or args.upload_streams:
        man_path = args.newer_stage_dir / "manifest.json"
        if not man_path.exists():
            raise SystemExit(f"Staged newer manifest not found: {man_path}")
        staged_man = json.loads(man_path.read_text(encoding="utf-8"))
        items = [m for tid, m in sorted(staged_man.items()) if tid not in excluded_ids]
        out_subdir = args.streams_out / f"{args.stream_codec}_{args.stream_bitrate}"
        stream_files: list[Path] = []
        stream_urls: dict[str, str] = {}

        if args.encode_streams:
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futs = [
                    pool.submit(
                        process_staged_stream_track,
                        ffmpeg_bin,
                        it,
                        out_subdir,
                        args.repo,
                        args.stream_tag,
                        args.stream_codec,
                        args.stream_bitrate,
                        args.stream_lowpass,
                    )
                    for it in items
                ]
                for fut in as_completed(futs):
                    res = fut.result()
                    if res["status"] == "ok":
                        stream_files.append(res["path"])
                        stream_urls[res["id"]] = res["stream_url"]
                        staged_man[res["id"]]["stream_url"] = res["stream_url"]
            atomic_write_text(man_path, json.dumps(staged_man, indent=2, ensure_ascii=False) + "\n")
            tot_mb = sum(p.stat().st_size for p in stream_files) / (1024 * 1024)
            print(f"Encoded {len(stream_files)}/{len(items)} newer streams ({args.stream_codec} @ {args.stream_bitrate}, {tot_mb:.1f} MB) -> {out_subdir}")
        else:
            ext = stream_ext_for_codec(args.stream_codec)
            for it in items:
                p = out_subdir / f"{it['id']}{ext}"
                if p.exists():
                    stream_files.append(p)
                    stream_urls[it["id"]] = release_download_url(args.repo, args.stream_tag, p.name)

        if args.upload_streams and stream_files:
            ensure_release(
                gh_bin,
                args.repo,
                args.stream_tag,
                "Audio Streams v1",
                f"Low-bitrate ({args.stream_codec} {args.stream_bitrate}) browser streaming assets for Bill Tribble Music Map.",
            )
            upload_assets_batched(gh_bin, args.repo, args.stream_tag, sorted(stream_files))
            print(f"Uploaded {len(stream_files)} stream assets to {args.repo} release {args.stream_tag}")

            # Promote precomputed full-track waveforms & cues + stream_url into waveforms_and_cues.json atomically
            pre_full_path = args.newer_stage_dir / "precomputed_full_waveforms.json"
            pre_full = json.loads(pre_full_path.read_text(encoding="utf-8")) if pre_full_path.exists() else {}
            wf_map = json.loads(args.waveforms_json.read_text(encoding="utf-8")) if args.waveforms_json.exists() else {}
            wf_map = {k: v for k, v in wf_map.items() if k not in excluded_ids}
            for tid, s_url in stream_urls.items():
                base_rec = {**(wf_map.get(tid) or {}), **(pre_full.get(tid) or {})}
                base_rec["stream_url"] = s_url
                wf_map[tid] = base_rec
            atomic_write_text(args.waveforms_json, json.dumps(wf_map, separators=(",", ":"), ensure_ascii=False) + "\n")
            print(f"Promoted {len(stream_urls)} full-track stream waveforms + stream_url entries in {args.waveforms_json}")

    if not args.encode_archive and not args.upload_archive:
        return

    if not args.manifest.exists():
        raise SystemExit(f"Manifest not found: {args.manifest}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    tier_b = [t for t in manifest.get("tracks", []) if t.get("tier") == "archive_dl" and t.get("id") not in excluded_ids]
    print(f"Found {len(tier_b)} non-excluded Tier B (<2015) archive tracks in manifest")

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


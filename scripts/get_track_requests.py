#!/usr/bin/env python3
"""Private GoatCounter CLI for checking track-request and track-download metrics.

Reads GOATCOUNTER_API_TOKEN from environment, an explicit --credentials-file
(defaulting to ~/.config/goatcounter/credentials.json), or macOS Keychain
(`security find-generic-password -s goatcounter-api-token -w`).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SITE_HOST = "billtribble-com.goatcounter.com"


def load_token(credentials_file: Path | None) -> str:
    env_tok = os.environ.get("GOATCOUNTER_API_TOKEN", "").strip()
    if env_tok:
        return env_tok

    cred_path = credentials_file or (Path.home() / ".config" / "goatcounter" / "credentials.json")
    if cred_path.exists():
        try:
            data = json.loads(cred_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                tok = str(data.get("api_token") or data.get("token") or "").strip()
                if tok:
                    return tok
        except Exception as exc:
            raise SystemExit(f"Failed reading credentials file {cred_path}: {exc}") from exc

    if sys.platform == "darwin":
        try:
            res = subprocess.run(
                ["security", "find-generic-password", "-s", "goatcounter-api-token", "-w"],
                capture_output=True,
                text=True,
                check=False,
            )
            if res.returncode == 0 and res.stdout.strip():
                return res.stdout.strip()
        except Exception:
            pass

    raise SystemExit(
        "No GoatCounter API token found. Set GOATCOUNTER_API_TOKEN, pass --credentials-file, "
        "or populate ~/.config/goatcounter/credentials.json."
    )


def fetch_hits(token: str, path_filter: str, start: str | None, end: str | None) -> list[dict]:
    params: dict[str, str] = {"limit": "100"}
    if start:
        params["start"] = start
    if end:
        params["end"] = end

    url = f"https://{SITE_HOST}/api/v0/stats/hits?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "music-map-goatcounter-cli/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    hits = payload.get("hits", [])
    if path_filter:
        hits = [h for h in hits if path_filter in str(h.get("path", ""))]
    return hits


def render_table(rows: list[dict], heading: str) -> None:
    print(f"\n=== {heading} ({len(rows)} paths) ===")
    if not rows:
        print("  (no recorded events)")
        return
    print(f"  {'Hits':>6s}  {'Path':<38s}  {'Title'}")
    print(f"  {'-' * 6}  {'-' * 38}  {'-' * 40}")
    for row in sorted(rows, key=lambda r: int(r.get("count", 0)), reverse=True):
        cnt = int(row.get("count", 0))
        path = str(row.get("path", ""))[:38]
        title = str(row.get("title", ""))[:60]
        print(f"  {cnt:6d}  {path:<38s}  {title}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Fetch private GoatCounter track request & download stats.")
    ap.add_argument("--credentials-file", type=Path, default=None, help="Path to GoatCounter credentials JSON")
    ap.add_argument("--filter", default="", help="Optional custom path filter (default: query both requests and downloads)")
    ap.add_argument("--start", default=None, help="Optional ISO start date (YYYY-MM-DD)")
    ap.add_argument("--end", default=None, help="Optional ISO end date (YYYY-MM-DD)")
    ap.add_argument("--json", action="store_true", help="Print raw JSON output")
    args = ap.parse_args()

    token = load_token(args.credentials_file)
    if args.filter:
        hits = fetch_hits(token, args.filter, args.start, args.end)
        if args.json:
            print(json.dumps(hits, indent=2))
        else:
            render_table(hits, f"Filter: {args.filter}")
        return

    requests = fetch_hits(token, "track-request/", args.start, args.end)
    downloads = fetch_hits(token, "track-download/", args.start, args.end)
    if args.json:
        print(json.dumps({"track_requests": requests, "track_downloads": downloads}, indent=2))
        return
    render_table(requests, "Track Requests (track-request/)")
    render_table(downloads, "Archive Downloads (track-download/)")


if __name__ == "__main__":
    main()

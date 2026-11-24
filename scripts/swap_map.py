#!/usr/bin/env python3
"""Instantly swap active music-map dataset between Discogs-400 and DSP heuristic."""

import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_DIR = os.path.join(ROOT, "js")
DATA_JS = os.path.join(JS_DIR, "data.js")
DATA_DSP = os.path.join(JS_DIR, "data-dsp.js")
DATA_DISCOGS = os.path.join(JS_DIR, "data-discogs.js")


def detect_active():
  if not os.path.exists(DATA_JS):
    return "missing"
  with open(DATA_JS, "r", encoding="utf-8") as f:
    head = f.read(4096)
  if '"classifier":"essentia-discogs400"' in head or "Essentia Discogs-400" in head:
    return "discogs"
  return "dsp"


def swap_to(target):
  if target == "discogs":
    if not os.path.exists(DATA_DISCOGS):
      print(f"Error: {DATA_DISCOGS} not found.", file=sys.stderr)
      return 1
    if not os.path.exists(DATA_DSP) and detect_active() == "dsp":
      shutil.copy2(DATA_JS, DATA_DSP)
      print(f"Backed up DSP map -> {DATA_DSP}")
    shutil.copy2(DATA_DISCOGS, DATA_JS)
    print(f"Swapped active map to: discogs ({DATA_JS})")
  elif target == "dsp":
    if not os.path.exists(DATA_DSP):
      print(f"Error: backup {DATA_DSP} not found.", file=sys.stderr)
      return 1
    shutil.copy2(DATA_DSP, DATA_JS)
    print(f"Restored active map to: dsp ({DATA_JS})")
  return 0


def main():
  parser = argparse.ArgumentParser(description="Swap active music-map dataset.")
  group = parser.add_mutually_exclusive_group(required=True)
  group.add_argument("--to", choices=["discogs", "dsp"], help="Target map dataset")
  group.add_argument("--status", action="store_true", help="Show active map status")
  args = parser.parse_args()

  if args.status:
    print(f"Active js/data.js: {detect_active()}")
    print(f"  data-dsp.js    : {'present' if os.path.exists(DATA_DSP) else 'not created yet'}")
    print(f"  data-discogs.js: {'present' if os.path.exists(DATA_DISCOGS) else 'missing'}")
    return 0
  return swap_to(args.to)


if __name__ == "__main__":
  sys.exit(main())

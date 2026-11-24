#!/usr/bin/env python3
"""Canonical catalog of all 29 officially released Bill Tribble tracks.

Maps album & track titles (and corpus/archive filenames) to verified Bandcamp,
Spotify, Apple Music, YouTube Music, and YouTube URLs. Platforms without a
verified direct track URL are omitted so zero dead links appear in the UI.
"""

from __future__ import annotations

import argparse
import re
import unicodedata
import urllib.request

RELEASE_ALBUMS = {
    "lucid_crystal": {
        "title": "Lucid Crystal Temple",
        "year": 2026,
        "bandcamp": "https://billtribble.bandcamp.com/album/lucid-crystal-temple",
        "spotify": "https://open.spotify.com/album/6RnyPOXORxA6bnVOV7Tr92",
    },
    "spirit_guides": {
        "title": "Spirit Guides",
        "year": 2025,
        "bandcamp": "https://billtribble.bandcamp.com/album/spirit-guides",
        "spotify": "https://open.spotify.com/album/25By5tf6YinwjOVCvgdH32",
    },
    "le_garage": {
        "title": "Le Garage Hermétique",
        "year": 2023,
        "bandcamp": "https://billtribble.bandcamp.com/album/le-garage-herm-tique",
        "spotify": "https://open.spotify.com/album/4tsLPAbeEC75y51arCSJNu",
    },
    "nihon_forever": {
        "title": "Nihon Forever",
        "year": 2018,
        "bandcamp": "https://billtribble.bandcamp.com/album/nihon-forever",
    },
    "intensity_01": {"title": "Intensity 01", "year": 2021},
}

_BC = "https://billtribble.bandcamp.com/track/"
_SP = "https://open.spotify.com/track/"
_AM = "https://music.apple.com/us/album/"
_YTM = "https://music.youtube.com/watch?v="
_YT = "https://www.youtube.com/watch?v="


def _rec(
    era: str,
    album: str,
    year: int,
    num: int,
    title: str,
    aliases: list[str],
    bc: str = "",
    sp: str = "",
    am: str = "",
    ytm: str = "",
    yt: str = "",
) -> dict:
    links = {}
    if bc:
        links["bandcamp"] = _BC + bc
    if sp:
        links["spotify"] = _SP + sp
    if ytm:
        links["youtube_music"] = _YTM + ytm
    if am:
        links["apple_music"] = _AM + am
    if yt:
        links["youtube"] = _YT + yt
    return {
        "era": era, "album": album, "year": year, "track_num": num,
        "title": title, "aliases": aliases, "links": links,
    }


OFFICIAL_RELEASES: list[dict] = [
    # Lucid Crystal Temple (2026, 4 tracks)
    _rec("lucid_crystal", "Lucid Crystal Temple", 2026, 1, "Crystal Temple Opening Ritual",
         ["crystal temple opening ritual", "opening ritual"],
         bc="crystal-temple-opening-ritual", sp="4airT2iuVf3c7ujtg9ZL9c",
         am="crystal-temple-opening-ritual/1867747891?i=1867747892", ytm="yCZeU2uLj2c", yt="yCZeU2uLj2c"),
    _rec("lucid_crystal", "Lucid Crystal Temple", 2026, 2, "Chromacolor", ["chromacolor"],
         bc="chromacolor", sp="6XrCD8c76zmWONZURN6O2e",
         am="chromacolor/1867747891?i=1867747893", ytm="Zl1htsK8QAg", yt="Zl1htsK8QAg"),
    _rec("lucid_crystal", "Lucid Crystal Temple", 2026, 3, "Lightstone Cave", ["lightstone cave"],
         bc="lightstone-cave", sp="1SM3snkPTeCUNFHqJ7LhDi",
         am="lightstone-cave/1867747891?i=1867747894"),
    _rec("lucid_crystal", "Lucid Crystal Temple", 2026, 4, "The Procession of Eternal Gratitude",
         ["the procession of eternal gratitude", "procession of eternal gratitude"],
         bc="the-procession-of-eternal-gratitude", sp="5DbTtjJryRnE7ToajOJyt9",
         am="the-procession-of-eternal-gratitude/1867747891?i=1867747895", ytm="yQOzS564_K0", yt="yQOzS564_K0"),
    # Spirit Guides (2025, 6 tracks)
    _rec("spirit_guides", "Spirit Guides", 2025, 1, "Call to adventure", ["call to adventure"],
         bc="call-to-adventure", sp="0Jh552T6PiFNKombwYNfwe",
         am="call-to-adventure/1824758105?i=1824758106", ytm="drNqTdSUQUw", yt="drNqTdSUQUw"),
    _rec("spirit_guides", "Spirit Guides", 2025, 2, "Forest of mysteries", ["forest of mysteries"],
         bc="forest-of-mysteries", sp="0Y4QDZYD9wuUrz4PdyuI02",
         am="forest-of-mysteries/1824758105?i=1824758107", ytm="jzCJwSfZ7tM", yt="OMfo5EPHh20"),
    _rec("spirit_guides", "Spirit Guides", 2025, 3, "Voice of the spirits", ["voice of the spirits"],
         bc="voice-of-the-spirits", sp="4V2AJwF8g8DUoukjkD5NBA",
         am="voice-of-the-spirits/1824758105?i=1824758108"),
    _rec("spirit_guides", "Spirit Guides", 2025, 4, "Passing over", ["passing over"],
         bc="passing-over", sp="1AJUfiT1rUATCAQyZpV1WO",
         am="passing-over/1824758105?i=1824758109", ytm="JZj-oupkR0Q", yt="JZj-oupkR0Q"),
    _rec("spirit_guides", "Spirit Guides", 2025, 5, "Dark night of the soul", ["dark night of the soul"],
         bc="dark-night-of-the-soul", sp="2pXGvNebIgA3jFdDqRmljS",
         am="dark-night-of-the-soul/1824758105?i=1824758110"),
    _rec("spirit_guides", "Spirit Guides", 2025, 6, "Loving arms of forgiveness", ["loving arms of forgiveness"],
         bc="loving-arms-of-forgiveness", sp="1Rh8Q2Y58XKXvVNAHm5Q4a",
         am="loving-arms-of-forgiveness/1824758105?i=1824758111"),
    # Le Garage Hermétique (2023, 8 tracks)
    _rec("le_garage", "Le Garage Hermétique", 2023, 1, "Le Garage Hermétique",
         ["le garage hermetique", "firefly dance"],
         bc="le-garage-herme-tique", sp="17cg9mIpkz3cqf62lO4mdT",
         am="le-garage-herm%C3%A9tique-feat-lovelace/1691414883?i=1691414884", ytm="lETltAHoxsc", yt="NMDZZVQ-9JU"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 2, "Escape from the Bakalite", ["escape from the bakalite"],
         bc="escape-from-the-bakalite", sp="4Jt4jhLho1ELCixETvo3kv",
         am="escape-from-the-bakalite-feat-cyra/1691414883?i=1691414886"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 3, "Tar'Hai Bells", ["tar hai bells", "tarhai bells", "tar hai"],
         bc="tarhai-bells", sp="03XjeabgFOKAJ7Gl9MOOzQ",
         am="tarhai-bells-feat-cyra/1691414883?i=1691414887"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 4, "The Gardens of Aedena", ["the gardens of aedena", "gardens of aedena"],
         bc="the-gardens-of-aedena", sp="00TyPdkmncWU9BXfi2MrLO",
         am="the-gardens-of-aedena-feat-cyra/1691414883?i=1691414888"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 5, "Nagual encounter (subterranean)",
         ["nagual encounter subterranean", "nagual encounter", "nagual"],
         bc="nagual-encounter-subterranean", sp="5dcReoHU4DsDESPQE0jhMR",
         am="nagual-encounter-feat-littlewing/1691414883?i=1691414889"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 6, "Jerry Cornelius' sanctum",
         ["jerry cornelius sanctum", "jerry cornelius"],
         bc="jerry-cornelius-sanctum", sp="1DHBzwGvBa96hQjdpRM4ee",
         am="jerry-cornelius-sanctum/1691414883?i=1691414890"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 7, "Major Grubert's enlightenment",
         ["major gruberts enlightenment", "major grubert s enlightenment", "major grubert"],
         bc="major-gruberts-enlightenment", sp="4DfjKSiMuP2HWdORJ2zUA4",
         am="major-gruberts-enlightenment-feat-cyra/1691414883?i=1691414891", ytm="5kvTdTuIcRE", yt="5kvTdTuIcRE"),
    _rec("le_garage", "Le Garage Hermétique", 2023, 8, "Sacred songs of Chiram",
         ["sacred songs of chiram", "sacred songs of chiram semeradana", "sacred songs chiram"],
         bc="sacred-songs-of-chiram", sp="5I2o1FmmfNtZHIXAwhlVPL",
         am="sacred-songs-of-chiram-feat-cyra/1691414883?i=1691414892"),
    # Nihon Forever (2018, 10 tracks)
    _rec("nihon_forever", "Nihon Forever", 2018, 1, "Korogi Song", ["korogi song"],
         bc="korogi-song", am="korogi-song/1567671380?i=1567671381"),
    _rec("nihon_forever", "Nihon Forever", 2018, 2, "Tokashiki Island", ["tokashiki island"],
         bc="tokashiki-island", am="tokashiki-island/1567671380?i=1567671383"),
    _rec("nihon_forever", "Nihon Forever", 2018, 3, "Shibuya Flyover", ["shibuya flyover"],
         bc="shibuya-flyover", am="shibuya-flyover/1567671380?i=1567671384"),
    _rec("nihon_forever", "Nihon Forever", 2018, 4, "Cicada Overlords", ["cicada overlords"],
         bc="cicada-overlords", am="cicada-overlords/1567671380?i=1567671386", ytm="AspDIm3OO0M", yt="AspDIm3OO0M"),
    _rec("nihon_forever", "Nihon Forever", 2018, 5, "Chigasaki Crossing", ["chigasaki crossing"],
         bc="chigasaki-crossing", am="chigasaki-crossing/1567671380?i=1567671387"),
    _rec("nihon_forever", "Nihon Forever", 2018, 6, "Yamanote Psychout", ["yamanote psychout"],
         bc="yamanote-psychout", am="yamanote-psychout/1567671380?i=1567671388"),
    _rec("nihon_forever", "Nihon Forever", 2018, 7, "Funabashi Massive", ["funabashi massive"],
         bc="funabashi-massive", am="funabashi-massive/1567671380?i=1567671389"),
    _rec("nihon_forever", "Nihon Forever", 2018, 8, "Ueno Monk", ["ueno monk"],
         bc="ueno-monk", am="ueno-monk/1567671380?i=1567671390"),
    _rec("nihon_forever", "Nihon Forever", 2018, 9, "Humans of Tsuboi", ["humans of tsuboi"],
         bc="humans-of-tsuboi", am="humans-of-tsuboi/1567671380?i=1567671391"),
    _rec("nihon_forever", "Nihon Forever", 2018, 10, "Kita Narashino", ["kita narashino"],
         bc="kita-narashino", am="kita-narashino/1567671380?i=1567671392"),
    # Intensity 01 (2021, 1 track)
    _rec("archive_2018_23", "Intensity 01", 2021, 3, "Nama Rupa (feat. Firephly)",
         ["nama rupa", "nama rupa feat firephly"],
         am="nama-rupa-feat-firephly/1579567051?i=1579567387", ytm="nNnMpuwJk8I", yt="h3KKQaKTv14"),
]


def _norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"\((?:semeradana|subterranean|feat\.?[^)]*|remaster[^)]*)\)", " ", s)
    s = re.sub(r"^\d{1,2}\s*[-._]?\s*", "", s)
    s = re.sub(r"[-_]*(?:remaster|master|lufs|smashed|hifi|final).*$", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


_ALIAS_MAP: dict[str, dict] = {}
for _rec_item in OFFICIAL_RELEASES:
    for _al in [_rec_item["title"], *_rec_item.get("aliases", [])]:
        _ALIAS_MAP[_norm_text(_al)] = _rec_item


def match_released_track(title: str, rel_path: str = "", era: str = "") -> dict | None:
    """Return matching official release entry for a track title/path, or None."""
    candidates = [_norm_text(title)]
    if rel_path:
        candidates.append(_norm_text(rel_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]))
    for cand in candidates:
        if not cand:
            continue
        if cand in _ALIAS_MAP:
            return _ALIAS_MAP[cand]
        for alias, rec in _ALIAS_MAP.items():
            if len(alias) >= 6 and (alias in cand or cand in alias):
                if not era or rec["era"] == era or rec["era"] == "archive_2018_23":
                    return rec
    return None


def verify_urls() -> tuple[int, int]:
    """Verify HTTP status for all cataloged streaming/purchase URLs."""
    ok = bad = 0
    for rec in OFFICIAL_RELEASES:
        for plat, url in rec["links"].items():
            for method in ("HEAD", "GET"):
                try:
                    req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=12) as resp:
                        if resp.status < 400:
                            ok += 1
                            break
                except Exception as exc:
                    if method == "GET":
                        bad += 1
                        print(f"[FAIL] {rec['title']} ({plat}): {exc} -> {url}")
    return ok, bad


def main() -> None:
    ap = argparse.ArgumentParser(description="Inspect and verify the 29 official released tracks.")
    ap.add_argument("--verify", action="store_true", help="Run live HTTP checks on all streaming URLs")
    args = ap.parse_args()
    total_links = sum(len(r["links"]) for r in OFFICIAL_RELEASES)
    print(f"Official tracks: {len(OFFICIAL_RELEASES)} | Verified streaming/purchase URLs: {total_links}")
    if args.verify:
        ok, bad = verify_urls()
        print(f"HTTP verification: {ok} OK, {bad} failed")
        if bad:
            raise SystemExit(1)


if __name__ == "__main__":
    main()

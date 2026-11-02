"""Build the GCGScanner card database from the official Gundam Card Game website.

Scrapes https://www.gundam-gcg.com/en/cards/ and writes a SQLite database with
every printing of every card. Alt arts use the official "_pN" suffix, which maps
1:1 to ExBurst's "-ALTN" notation (GD06-002_p1 -> GD06-002-ALT1).

Uses only the Python standard library. All HTTP responses are cached on disk, so
re-running only fetches what is missing.

    python tools/carddb/build_carddb.py                # card list only (fast)
    python tools/carddb/build_carddb.py --details      # + rarity, type, stats, effect
    python tools/carddb/build_carddb.py --images       # + download card images
"""

import argparse
import html
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://www.gundam-gcg.com/en/cards/"
USER_AGENT = "GCGScanner-carddb/0.1 (private hobby project)"
REPO_ROOT = Path(__file__).resolve().parents[2]

OFFICIAL_ID_RE = re.compile(r"^(?P<card_no>[A-Z]+\d*-\d{3})(?:_p(?P<alt>\d+))?$")


@dataclass
class Variant:
    official_id: str
    card_no: str
    alt_index: int
    name: str
    image_path: str
    package_ids: set = field(default_factory=set)
    details: dict = field(default_factory=dict)

    @property
    def exburst_id(self) -> str:
        return self.card_no if self.alt_index == 0 else f"{self.card_no}-ALT{self.alt_index}"

    @property
    def image_url(self) -> str:
        return urllib.parse.urljoin(BASE_URL, self.image_path)


class Fetcher:
    def __init__(self, cache_dir: Path, delay: float, refresh_lists: bool):
        self.cache_dir = cache_dir
        self.delay = delay
        self.refresh_lists = refresh_lists
        self._last_request = 0.0

    def get(self, url: str, cache_name: str, binary: bool = False, cacheable: bool = True):
        path = self.cache_dir / cache_name
        if path.exists() and cacheable:
            data = path.read_bytes()
        else:
            wait = self._last_request + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
            self._last_request = time.monotonic()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return data if binary else data.decode("utf-8")


def clean_text(fragment: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", fragment)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def parse_packages(index_html: str) -> dict:
    """Return {package_id: label} from the search filter, e.g. 616106 -> 'Stardust Trails [GD06]'."""
    packages = {}
    for match in re.finditer(r'data-val="(6\d{5})"\s*>([^<]+)</a>', index_html):
        packages[match.group(1)] = html.unescape(match.group(2)).strip()
    return packages


def parse_card_list(list_html: str) -> list:
    """Return [(official_id, name, image_path)] for every card tile on a list page."""
    items = re.findall(
        r'detailSearch=([^"]+)"[^>]*>\s*<img[^>]*data-src="([^"?]+)[^"]*"\s+alt="([^"]*)"',
        list_html,
    )
    return [(official_id, html.unescape(name), image) for official_id, image, name in items]


def parse_detail(detail_html: str) -> dict:
    details = {}
    rarity = re.search(r'<div class="rarity">(.*?)</div>', detail_html, re.S)
    if rarity:
        details["rarity"] = re.sub(r"\s+", "", clean_text(rarity.group(1)))
    block = re.search(r'<div class="blockIcon">(.*?)</div>', detail_html, re.S)
    if block:
        details["block"] = clean_text(block.group(1))
    effect = re.search(r'<div class="cardDataRow overview">\s*<div class="dataTxt[^"]*">(.*?)</div>',
                       detail_html, re.S)
    if effect:
        details["effect"] = clean_text(effect.group(1))
    for title, value in re.findall(
        r'<dt class="dataTit">(.*?)</dt>\s*<dd class="dataTxt[^"]*">(.*?)</dd>', detail_html, re.S
    ):
        details[clean_text(title).lower()] = clean_text(value)
    return details


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def collect_variants(fetcher: Fetcher, packages: dict) -> dict:
    variants = {}
    for package_id, label in packages.items():
        list_html = fetcher.get(
            f"{BASE_URL}index.php?package={package_id}",
            f"lists/{package_id}.html",
            cacheable=not fetcher.refresh_lists,
        )
        tiles = parse_card_list(list_html)
        print(f"  {label}: {len(tiles)} cards")
        for official_id, name, image_path in tiles:
            match = OFFICIAL_ID_RE.match(official_id)
            if not match:
                print(f"    WARNING: unexpected card id {official_id!r}, skipped", file=sys.stderr)
                continue
            variant = variants.get(official_id)
            if variant is None:
                variant = Variant(
                    official_id=official_id,
                    card_no=match.group("card_no"),
                    alt_index=int(match.group("alt") or 0),
                    name=name,
                    image_path=image_path,
                )
                variants[official_id] = variant
            variant.package_ids.add(package_id)
    return variants


SCHEMA = """
CREATE TABLE meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE package (
    id    TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL
);
CREATE TABLE card (
    card_no      TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT,
    color        TEXT,
    level        INTEGER,
    cost         INTEGER,
    ap           INTEGER,
    hp           INTEGER,
    zone         TEXT,
    trait        TEXT,
    link         TEXT,
    source_title TEXT,
    effect       TEXT
);
CREATE TABLE variant (
    exburst_id  TEXT PRIMARY KEY NOT NULL,
    official_id TEXT NOT NULL UNIQUE,
    card_no     TEXT NOT NULL REFERENCES card(card_no),
    alt_index   INTEGER NOT NULL,
    rarity      TEXT,
    image_url   TEXT NOT NULL,
    image_file  TEXT
);
CREATE INDEX index_variant_card_no ON variant(card_no);
CREATE TABLE variant_package (
    exburst_id TEXT NOT NULL REFERENCES variant(exburst_id),
    package_id TEXT NOT NULL REFERENCES package(id),
    PRIMARY KEY (exburst_id, package_id)
);
"""


def write_database(out_path: Path, packages: dict, variants: dict, image_dir: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp")
    tmp_path.unlink(missing_ok=True)
    db = sqlite3.connect(tmp_path)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO package VALUES (?, ?)", packages.items())

    by_card = {}
    for variant in variants.values():
        by_card.setdefault(variant.card_no, []).append(variant)

    for card_no, card_variants in sorted(by_card.items()):
        # Base printing carries the canonical data; fall back to any variant that has details.
        card_variants.sort(key=lambda v: v.alt_index)
        source = next((v for v in card_variants if v.details), card_variants[0])
        d = source.details
        db.execute(
            "INSERT INTO card VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                card_no, source.name, d.get("type"), d.get("color"), to_int(d.get("lv.")),
                to_int(d.get("cost")), to_int(d.get("ap")), to_int(d.get("hp")), d.get("zone"),
                d.get("trait"), d.get("link"), d.get("source title"), d.get("effect"),
            ),
        )
        for v in card_variants:
            image_file = Path(v.image_path).name
            db.execute(
                "INSERT INTO variant VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    v.exburst_id, v.official_id, card_no, v.alt_index, v.details.get("rarity"),
                    v.image_url, image_file if (image_dir / image_file).exists() else None,
                ),
            )
            db.executemany(
                "INSERT INTO variant_package VALUES (?, ?)",
                [(v.exburst_id, package_id) for package_id in sorted(v.package_ids)],
            )

    db.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("source", BASE_URL),
            ("built_at", datetime.now(timezone.utc).isoformat(timespec="seconds")),
            ("card_count", str(len(by_card))),
            ("variant_count", str(len(variants))),
        ],
    )
    db.commit()
    db.close()
    tmp_path.replace(out_path)
    return len(by_card)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "cards.db")
    parser.add_argument("--cache", type=Path, default=REPO_ROOT / "build" / "carddb-cache")
    parser.add_argument("--details", action="store_true", help="fetch the detail page of every printing")
    parser.add_argument("--images", action="store_true", help="download every card image")
    parser.add_argument("--refresh", action="store_true", help="re-download the card lists (e.g. after a new set)")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between requests")
    args = parser.parse_args()
    # Show progress immediately when redirected to a log file; card names contain non-ASCII (e.g. "・").
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

    fetcher = Fetcher(args.cache, args.delay, args.refresh)
    image_dir = args.cache / "images"

    print("Fetching package list ...")
    packages = parse_packages(fetcher.get(BASE_URL, "index.html", cacheable=not args.refresh))
    print(f"Found {len(packages)} packages. Fetching card lists ...")
    variants = collect_variants(fetcher, packages)
    print(f"Found {len(variants)} printings.")

    if args.details or args.images:
        todo = sorted(variants.values(), key=lambda v: v.official_id)
        for i, variant in enumerate(todo, 1):
            if args.details:
                detail_html = fetcher.get(
                    f"{BASE_URL}detail.php?detailSearch={urllib.parse.quote(variant.official_id)}",
                    f"details/{variant.official_id}.html",
                )
                variant.details = parse_detail(detail_html)
            if args.images:
                fetcher.get(variant.image_url, f"images/{Path(variant.image_path).name}", binary=True)
            if i % 100 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}")

    card_count = write_database(args.out, packages, variants, image_dir)
    print(f"Wrote {card_count} cards / {len(variants)} printings to {args.out}")


if __name__ == "__main__":
    main()

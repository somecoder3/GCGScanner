"""Draw the PWA icons (a card in a scan frame) as PNGs into pwa/icons/.

Needs numpy (already in build/venv, see tools/model/requirements.txt):

    build/venv/Scripts/python tools/icons/make_icons.py
"""

import struct
import zlib
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT = REPO_ROOT / "pwa" / "icons"

BG = (0x11, 0x14, 0x18)
CARD = (0x1C, 0x21, 0x28)
ACCENT = (0x4F, 0xC3, 0xF7)
OK = (0x66, 0xBB, 0x6A)
SUPERSAMPLE = 4


def rounded_rect(x, y, cx, cy, w, h, r):
    """Mask of a rounded rectangle centred at (cx, cy); coordinates in 0..1."""
    dx = np.maximum(np.abs(x - cx) - (w / 2 - r), 0)
    dy = np.maximum(np.abs(y - cy) - (h / 2 - r), 0)
    return dx * dx + dy * dy <= r * r


def draw(size, maskable):
    n = size * SUPERSAMPLE
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n
    img = np.zeros((n, n, 4))
    # Maskable icons get cropped to a circle or squircle by Android: full background, art in the
    # inner 80 %. The normal icon is a rounded square with the art a bit larger.
    scale = 0.72 if maskable else 0.86
    bg = np.ones_like(x, bool) if maskable else rounded_rect(x, y, 0.5, 0.5, 1, 1, 0.2)
    img[bg] = (*BG, 255)

    def s(v):  # scale around the centre
        return 0.5 + (v - 0.5) * scale

    card_h = 0.74 * scale
    card_w = card_h * 63 / 88
    card = rounded_rect(x, y, 0.5, 0.5, card_w, card_h, 0.05 * scale)
    border = card & ~rounded_rect(x, y, 0.5, 0.5, card_w - 0.05 * scale, card_h - 0.05 * scale, 0.03 * scale)
    img[card] = (*CARD, 255)
    img[border] = (*ACCENT, 255)
    # art window and text lines on the card
    art = rounded_rect(x, y, 0.5, s(0.40), card_w * 0.72, card_h * 0.42, 0.015 * scale)
    img[art] = (*[c * 0.55 for c in ACCENT], 255)
    for line_y, width in ((0.66, 0.6), (0.72, 0.45)):
        img[rounded_rect(x, y, 0.5, s(line_y), card_w * width, 0.028 * scale, 0.014 * scale)] = (*[c * 0.7 for c in ACCENT], 255)
    # scan line across the card
    scan = rounded_rect(x, y, 0.5, s(0.53), card_w * 1.3, 0.04 * scale, 0.02 * scale)
    img[scan] = (*OK, 255)
    # corner brackets of the scan frame
    fw, fh, t, arm = card_w * 1.38, card_h * 1.18, 0.035 * scale, 0.16 * scale
    for sx in (-1, 1):
        for sy in (-1, 1):
            ex, ey = 0.5 + sx * fw / 2, 0.5 + sy * fh / 2
            # each arm runs from the outer edge of the other arm (t/2 past the corner) inwards
            length = arm + t / 2
            horiz = (np.abs(y - ey) <= t / 2) & (np.abs(x - (ex + sx * t / 2 - sx * length / 2)) <= length / 2)
            vert = (np.abs(x - ex) <= t / 2) & (np.abs(y - (ey + sy * t / 2 - sy * length / 2)) <= length / 2)
            img[horiz | vert] = (*OK, 255)

    img = img.reshape(size, SUPERSAMPLE, size, SUPERSAMPLE, 4).mean(axis=(1, 3))
    return np.clip(np.round(img), 0, 255).astype(np.uint8)


def write_png(path, rgba):
    height, width, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[row].tobytes() for row in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False), ("icon-maskable-512.png", 512, True)):
        write_png(OUT / name, draw(size, maskable))
        print(f"Wrote {OUT / name}")


if __name__ == "__main__":
    main()

"""Stamp the real Calas mark (calas-vault Brand/dc-logo, crescent WITH its diagonal stroke) onto the Monomem brand images.

The stroke is part of the logo, not an artifact. This replaces whatever mark is in each image with the official one,
recoloured white (the official mark on dark), on the brand navy. Run with a Python that has Pillow:
  ~/tools/motion-venv/Scripts/python.exe scripts/stamp-calas-mark.py <path to dc-logo-2048.png>
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

NAVY = (11, 46, 69)
GOLD = (255, 255, 255)  # the official mark on a dark background is white (calas-vault SOP/Brand.md)
ROOT = Path(__file__).resolve().parent.parent

# image, box to clear (x0, y0, x1, y1), mark height, top-left of the mark
TARGETS = [
    ("docs/brand/monomem-banner.png", (90, 50, 360, 310), 230, (105, 65)),
    ("docs/brand/social-preview.png", (90, 170, 340, 420), 210, (105, 185)),
]


def gold_mark(src: Image.Image, height: int) -> Image.Image:
    a = src.convert("RGBA").split()[3]
    bbox = a.getbbox()
    a = a.crop(bbox)
    w = round(a.width * height / a.height)
    a = a.resize((w, height), Image.LANCZOS)
    mark = Image.new("RGBA", a.size, GOLD + (0,))
    mark.putalpha(a)
    return mark


def main() -> None:
    src = Image.open(sys.argv[1])
    for rel, box, h, xy in TARGETS:
        p = ROOT / rel
        im = Image.open(p).convert("RGB")
        ImageDraw.Draw(im).rectangle(box, fill=NAVY)
        m = gold_mark(src, h)
        im.paste(m, xy, m)
        im.save(p)
        print(f"{rel}: Calas mark stamped ({m.width}x{m.height})")
    for rel, bg, fg, size in [("docs/brand/mark-gold-48.png", None, GOLD, 48), ("docs/brand/mark-navy-48.png", None, NAVY, 48)]:
        m = gold_mark(src, size)
        if fg != GOLD:
            m = Image.new("RGBA", m.size, fg + (0,)); m.putalpha(gold_mark(src, size).split()[3])
        m.save(ROOT / rel)
        print(f"{rel}: Calas mark {m.width}x{m.height}")
    fav = Image.new("RGBA", (64, 64), NAVY + (255,))
    m = gold_mark(src, 52)
    fav.paste(m, ((64 - m.width) // 2, 6), m)
    fav.save(ROOT / "docs/brand/favicon-64.png")
    print("docs/brand/favicon-64.png: Calas mark on navy")


if __name__ == "__main__":
    main()

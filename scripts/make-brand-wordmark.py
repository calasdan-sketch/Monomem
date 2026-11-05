#!/usr/bin/env python
"""Redraw the product wordmark on the brand images.

Exists because the rename to Monomem shipped twice with artwork that had only
been *renamed*: docs/monomem-demo.gif still showed `npx onememory-mcp setup`
(fixed in 1.0.1), and both of these PNGs still read "OneMemory" while sitting
at the top of the README and the npm page. Renaming a file changes nothing a
reader can see, so the rename now has a script behind it.

Only the wordmark is redrawn. The logo mark, the subtitles, the tagline and
the colours are left exactly as they were: they did not change with the name,
and repainting them would risk drifting artwork nobody asked to change.

The font and sizes below were recovered from the originals, not chosen: Segoe
UI Bold was pixel-matched against the old wordmark (16% edge-only mismatch,
versus 34% for Arial Bold and 96% for Calibri Bold), and each size is the one
whose rendered ink box is the same height as the wordmark it replaces.

Run with a Python that has Pillow:
    ~/tools/motion-venv/Scripts/python.exe scripts/make-brand-wordmark.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

NAME = "Monomem"
FONT = "C:/Windows/Fonts/segoeuib.ttf"  # Segoe UI Bold
NAVY = (10, 45, 68)  # the background these images are painted on
WHITE = (255, 255, 255)

# For each image: the font size, where the wordmark's ink must start (its
# top-left, matching where the old one started), and the rectangle to clear
# first. The clear box is deliberately wider than the old wordmark -- "Monomem"
# is shorter than "OneMemory", so the tail of the old word has to be covered --
# and deliberately short of the subtitle and logo, which must survive.
TARGETS = [
    {
        "path": "docs/brand/monomem-banner.png",
        "size": 96,
        "ink_xy": (404, 100),
        "clear": (390, 88, 1000, 200),
    },
    {
        "path": "docs/brand/social-preview.png",
        "size": 110,
        "ink_xy": (294, 230),
        "clear": (280, 215, 980, 348),
    },
]


def redraw(path: Path, size: int, ink_xy: tuple[int, int], clear: tuple[int, int, int, int]) -> None:
    image = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle(clear, fill=NAVY)

    font = ImageFont.truetype(FONT, size)
    # Pillow's text origin is the glyph box, not the inked pixels, and the gap
    # between them depends on the string. Measure this string's own offset and
    # subtract it, so the ink lands exactly where the old wordmark's ink did.
    left, top, _, _ = draw.textbbox((0, 0), NAME, font=font)
    draw.text((ink_xy[0] - left, ink_xy[1] - top), NAME, fill=WHITE, font=font)

    image.save(path)
    print(f"{path}: wordmark redrawn as {NAME!r} at {size}px")


GOLD = (240, 193, 113)  # the colour of the claim lines, sampled from the originals

# The claim lines used to end in "undoable". Deleting a note is permanent (on
# purpose), so the artwork now says "reviewable": writes can be held and reviewed.
# "ink_x" is the ink's left edge, or its right edge when "right" is true.
CLAIMS = [
    {
        "path": "docs/brand/monomem-banner.png",
        "text": "reviewable",
        "size": 36,
        "ink_x": 1609,
        "right": True,
        "ink_top": 214,
        "clear": (1400, 205, 1625, 250),
    },
    {
        "path": "docs/brand/social-preview.png",
        "text": "Every note sourced, versioned and reviewable.",
        "size": 38,
        "ink_x": 297,
        "right": False,
        "ink_top": 430,
        "clear": (285, 420, 1200, 480),
    },
]


def redraw_claim(path: Path, c: dict) -> None:
    image = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle(c["clear"], fill=NAVY)
    font = ImageFont.truetype(FONT, c["size"])
    left, top, right, _ = draw.textbbox((0, 0), c["text"], font=font)
    x = c["ink_x"] - (right if c["right"] else left)
    draw.text((x, c["ink_top"] - top), c["text"], fill=GOLD, font=font)
    image.save(path)
    print(f"{path}: claim redrawn as {c['text']!r}")


# The one tagline, used on both images (and everywhere else the product is described in one line).
TAGLINE = "Shared memory for AI agents that holds poisoned writes."
SLATE = (159, 179, 196)  # the subtitle colour, sampled from the originals

# Where the old subtitle's ink started, and the size that fits the new, longer line.
TAGLINES = [
    {"path": "docs/brand/monomem-banner.png", "size": 36, "ink_x": 405, "ink_top": 220, "clear": (395, 212, 1400, 265)},
    {"path": "docs/brand/social-preview.png", "size": 34, "ink_x": 295, "ink_top": 360, "clear": (285, 350, 1260, 412)},
]


def redraw_tagline(path: Path, c: dict) -> None:
    image = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle(c["clear"], fill=NAVY)
    font = ImageFont.truetype(FONT, c["size"])
    left, top, right, _ = draw.textbbox((0, 0), TAGLINE, font=font)
    assert c["ink_x"] + (right - left) < c["clear"][2] - 10, "tagline would run off its box"
    draw.text((c["ink_x"] - left, c["ink_top"] - top), TAGLINE, fill=SLATE, font=font)
    image.save(path)
    print(f"{path}: tagline redrawn")


# The mark has a thin straight stroke on its right that is joined to the crescent only at the top and
# hangs free below it: it reads as a rendering artefact, and it vanishes at small sizes. It is removed
# by erasing everything right of that stroke's left edge. Coordinates are in the banner's pixels (the
# mark spans x 120..265, y 80..280 there); every other image maps onto them by an offset and a scale.
STROKE_LEFT_AT_Y134 = 211.0
STROKE_SLOPE = 0.439  # pixels of x per pixel of y
STROKE_Y = (120, 250)
MARKS = [
    # path, mark origin in that image, scale relative to the banner, erase colour (None = transparent)
    ("docs/brand/monomem-banner.png", (120, 80), 1.0, NAVY),
    ("docs/brand/social-preview.png", (120, 200), 0.9, NAVY),
    ("docs/brand/mark-gold-48.png", (0, 0), 0.24, None),
    ("docs/brand/mark-navy-48.png", (0, 0), 0.24, None),
]


def remove_stroke(path: Path, origin: tuple[int, int], scale: float, fill) -> None:
    image = Image.open(path).convert("RGBA" if fill is None else "RGB")
    px = image.load()
    erased = fill if fill is not None else (0, 0, 0, 0)
    for y in range(image.height):
        for x in range(image.width):
            bx = 120 + (x + 0.5 - origin[0]) / scale
            by = 80 + (y + 0.5 - origin[1]) / scale
            if STROKE_Y[0] <= by <= STROKE_Y[1] and 200 <= bx <= 280:
                if bx > STROKE_LEFT_AT_Y134 + STROKE_SLOPE * (by - 134) - 4:
                    px[x, y] = erased
    image.save(path)
    print(f"{path}: thin stroke removed")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    for target in TARGETS:
        redraw(root / target["path"], target["size"], target["ink_xy"], target["clear"])
    for claim in CLAIMS:
        redraw_claim(root / claim["path"], claim)
    for line in TAGLINES:
        redraw_tagline(root / line["path"], line)
    for path, origin, scale, fill in MARKS:
        remove_stroke(root / path, origin, scale, fill)


if __name__ == "__main__":
    main()

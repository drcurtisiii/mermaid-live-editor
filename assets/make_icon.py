"""Generates assets/app.ico (16-256 px) and assets/app-icon-preview.png.

Edit colors/shapes below and run:  python assets/make_icon.py
Design: a small flowchart (three nodes, two arrows) on a deep-teal tile with
a pencil tip - "view and edit diagrams".
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
S = 1024  # master canvas; downsampled for each ICO size

BG_TOP = (18, 52, 86)
BG_BOTTOM = (10, 110, 120)
NODE = (255, 255, 255)
NODE_ACCENT = (255, 196, 61)
LINE = (220, 240, 245)
PENCIL = (255, 120, 90)
PENCIL_TIP = (250, 225, 190)
LEAD = (40, 40, 48)


def gradient_tile() -> Image.Image:
    tile = Image.new("RGBA", (S, S))
    draw = ImageDraw.Draw(tile)
    for y in range(S):
        t = y / (S - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        draw.line([(0, y), (S, y)], fill=color + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([24, 24, S - 24, S - 24], radius=200, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(tile, mask=mask)
    return out


def arrow(draw: ImageDraw.ImageDraw, start, end, width=34):
    draw.line([start, end], fill=LINE, width=width)
    (x1, y1), (x2, y2) = start, end
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    size = 70
    left = (x2 - size * math.cos(angle - 0.5), y2 - size * math.sin(angle - 0.5))
    right = (x2 - size * math.cos(angle + 0.5), y2 - size * math.sin(angle + 0.5))
    draw.polygon([end, left, right], fill=LINE)


def build() -> Image.Image:
    img = gradient_tile()
    draw = ImageDraw.Draw(img)
    # Top node (accent), two child nodes.
    draw.rounded_rectangle([362, 150, 662, 330], radius=48, fill=NODE_ACCENT)
    draw.rounded_rectangle([130, 600, 410, 770], radius=48, fill=NODE)
    draw.ellipse([560, 580, 800, 800], fill=NODE)
    arrow(draw, (470, 335), (290, 585))
    arrow(draw, (560, 335), (670, 565))
    # Pencil across the lower-right corner.
    pencil = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pencil)
    pd.rounded_rectangle([420, 470, 900, 570], radius=24, fill=PENCIL)
    pd.polygon([(420, 470), (420, 570), (300, 520)], fill=PENCIL_TIP)
    pd.polygon([(345, 500), (345, 540), (300, 520)], fill=LEAD)
    pencil = pencil.rotate(-40, center=(600, 520), resample=Image.BICUBIC)
    img.alpha_composite(pencil, dest=(70, 250))
    return img


def main() -> None:
    master = build()
    preview = master.resize((256, 256), Image.LANCZOS)
    preview.save(HERE / "app-icon-preview.png")
    sizes = [(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]
    master.save(HERE / "app.ico", sizes=sizes)
    print("wrote", HERE / "app.ico", "and", HERE / "app-icon-preview.png")


if __name__ == "__main__":
    main()

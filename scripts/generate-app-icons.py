"""Generate app tiles from the transparent brand mark. Requires Pillow.

Run: python scripts/generate-app-icons.py
The fourth-order superellipse has continuous curvature (G2), including at the
axis extrema. Supersampling keeps the transparent edge smooth at small sizes.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024
SCALE = 4
INSET = 32

mark = Image.open(ROOT / "public/oint-logo.png").convert("RGBA")
mark = mark.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
tile = Image.new("RGBA", (SIZE, SIZE), "white")
tile.alpha_composite(mark)

mask = Image.new("L", (SIZE * SCALE, SIZE * SCALE))
center = SIZE * SCALE / 2
radius = (SIZE / 2 - INSET) * SCALE
points = []
for step in range(4096):
    angle = 2 * math.pi * step / 4096
    cosine, sine = math.cos(angle), math.sin(angle)
    points.append((
        center + radius * math.copysign(math.sqrt(abs(cosine)), cosine),
        center + radius * math.copysign(math.sqrt(abs(sine)), sine),
    ))
ImageDraw.Draw(mask).polygon(points, fill=255)
tile.putalpha(mask.resize((SIZE, SIZE), Image.Resampling.LANCZOS))
tile.save(ROOT / "public/oint.png", optimize=True)
tile.save(ROOT / "build/icon.png", optimize=True)
tile.save(ROOT / "build/icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
print("Generated public/oint.png, build/icon.png and build/icon.ico")

"""Outline the wordmark from one face of a TTC at the kerned positions Chromium measured.

Usage: wordmark_outline.py <ttc> <face index> <text> <positions.json> <tracking em> <out.json>
Writes {path, width, ascent, capHeight, upem}; path is in font units, y down, baseline at y=0.
"""
import json
import sys
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection

ttc, index, text, pos_file, tracking, out = sys.argv[1:7]
font = TTCollection(ttc).fonts[int(index)]
upem = font["head"].unitsPerEm
cmap = font.getBestCmap()
glyphs = font.getGlyphSet()
pos = json.load(open(pos_file))["x"]
if len(pos) != len(text):
    raise SystemExit(f"{len(pos)} positions for {len(text)} characters")

track = float(tracking) * upem
pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
for i, ch in enumerate(text):
    x = pos[i] + track * i
    # Flip y so the path reads top-down like the rest of the SVG.
    glyphs[cmap[ord(ch)]].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))

last = text[-1]
width = pos[-1] + track * (len(text) - 1) + glyphs[cmap[ord(last)]].width
os2 = font["OS/2"]
json.dump(
    {"path": pen.getCommands(), "width": round(width, 1), "capHeight": os2.sCapHeight,
     "xHeight": os2.sxHeight, "descender": font["hhea"].descent, "upem": upem,
     "font": font["name"].getDebugName(4), "version": font["name"].getDebugName(5)},
    open(out, "w"),
)
print(out, "glyphs", len(text), "width", round(width, 1), "capHeight", os2.sCapHeight)

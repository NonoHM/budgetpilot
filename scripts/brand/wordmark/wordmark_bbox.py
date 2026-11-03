"""Ink bounding box of the outlined wordmark path (y down), so lockups are laid out on ink, not metrics."""
import json
import sys
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection

ttc, index, text, pos_file, tracking = sys.argv[1:6]
font = TTCollection(ttc).fonts[int(index)]
upem = font["head"].unitsPerEm
cmap, glyphs = font.getBestCmap(), font.getGlyphSet()
pos = json.load(open(pos_file))["x"]
pen = BoundsPen(glyphs)
for i, ch in enumerate(text):
    glyphs[cmap[ord(ch)]].draw(TransformPen(pen, (1, 0, 0, -1, pos[i] + float(tracking) * upem * i, 0)))
print(json.dumps([round(v, 1) for v in pen.bounds]))

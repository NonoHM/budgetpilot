import sys
from fontTools.ttLib import TTCollection

ttc, index, out = sys.argv[1:4]
TTCollection(ttc).fonts[int(index)].save(out)
print(out)

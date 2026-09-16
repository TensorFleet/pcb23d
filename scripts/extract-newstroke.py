#!/usr/bin/env python3
"""Regenerate packages/core/src/font/newstroke.ts from a KiCad checkout's common/newstroke_font.cpp."""
import json, re, sys
src = sys.argv[1] if len(sys.argv) > 1 else "../kicad/common/newstroke_font.cpp"
s = open(src, encoding="utf-8", errors="replace").read()
body = s[s.index("newstroke_font[] ="):]
strs = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
glyphs = [bytes(x, "utf-8").decode("unicode_escape") for x in strs[:224]]
header = open(__file__.replace("extract-newstroke.py", "../packages/core/src/font/newstroke.ts")).read().split("export const NEWSTROKE_FIRST_CODEPOINT")[0]
with open("packages/core/src/font/newstroke.ts", "w") as f:
    f.write(header)
    f.write("export const NEWSTROKE_FIRST_CODEPOINT = 0x20;\nexport const NEWSTROKE_GLYPHS: readonly string[] = ")
    f.write(json.dumps(glyphs, ensure_ascii=True, indent=0).replace("\n", " \n"))
    f.write(";\n")
print(f"wrote {len(glyphs)} glyphs")

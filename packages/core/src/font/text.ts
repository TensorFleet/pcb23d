/**
 * Lays out text with KiCad's Newstroke stroke font and returns polylines in board
 * coordinates. Metrics follow KiCad's STROKE_FONT / FONT::getLinePositions so silkscreen
 * text lands where pcbnew draws it.
 */
import { rotate, type Vec2 } from "../geometry";
import { NEWSTROKE_FIRST_CODEPOINT, NEWSTROKE_GLYPHS } from "./newstroke";

const SCALE = 1 / 21;
const FONT_OFFSET = -8;
const ITALIC_TILT = 1 / 8;
const INTER_CHAR = 0.2;
const INTERLINE = 1.62 * 0.9583;

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "center" | "bottom";

export interface TextStyle {
  /** Glyph width (mm). KiCad files write `(size height width)`. */
  sizeX: number;
  sizeY: number;
  thickness: number;
  bold: boolean;
  italic: boolean;
  halign: HAlign;
  valign: VAlign;
  /** Mirror around the anchor (text on the back of the board). */
  mirror: boolean;
}

export interface Glyph {
  /** Advance width in glyph units (1.0 ≈ the glyph size). */
  advance: number;
  strokes: Vec2[][];
}

const cache = new Map<string, Glyph>();

export function parseGlyph(encoded: string): Glyph {
  let glyph = cache.get(encoded);
  if (glyph) return glyph;
  const startX = (encoded.charCodeAt(0) - 82) * SCALE;
  const endX = (encoded.charCodeAt(1) - 82) * SCALE;
  const strokes: Vec2[][] = [];
  let current: Vec2[] = [];
  for (let i = 2; i + 1 < encoded.length; i += 2) {
    const a = encoded[i]!;
    const b = encoded[i + 1]!;
    if (a === " " && b === "R") {
      if (current.length) strokes.push(current);
      current = [];
      continue;
    }
    current.push({
      x: (encoded.charCodeAt(i) - 82) * SCALE - startX,
      y: (encoded.charCodeAt(i + 1) - 82 + FONT_OFFSET) * SCALE,
    });
  }
  if (current.length) strokes.push(current);
  glyph = { advance: endX - startX, strokes };
  cache.set(encoded, glyph);
  return glyph;
}

export function glyphFor(ch: string): Glyph {
  let index = ch.codePointAt(0)! - NEWSTROKE_FIRST_CODEPOINT;
  if (index < 0 || index >= NEWSTROKE_GLYPHS.length || !NEWSTROKE_GLYPHS[index]) index = 63 - NEWSTROKE_FIRST_CODEPOINT; // '?'
  return parseGlyph(NEWSTROKE_GLYPHS[index]!);
}

const SPACE_ADVANCE = parseGlyph(NEWSTROKE_GLYPHS[0]!).advance;

/** Width of one line in mm, matching KiCad's bounding box (advance sum minus inter-char gap). */
export function lineWidth(line: string, style: TextStyle): number {
  let x = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t") x += SPACE_ADVANCE * style.sizeX;
    else x += glyphFor(ch).advance * style.sizeX;
  }
  return line.length ? x - style.sizeX * INTER_CHAR : 0;
}

/** Default pen width KiCad uses when a text has no explicit thickness. */
export function defaultThickness(sizeX: number, bold: boolean): number {
  return bold ? sizeX / 5 : sizeX / 8;
}

/**
 * Stroke polylines (board mm, KiCad y-down) for `text` anchored at `at`, rotated by `angle`
 * degrees (KiCad counter-clockwise convention).
 */
export function textStrokes(text: string, at: Vec2, angle: number, style: TextStyle): Vec2[][] {
  const lines = text.split("\n");
  const interline = style.sizeY * INTERLINE;
  let height = 0;
  for (let i = 0; i < lines.length; i++) height += i === 0 ? style.sizeY * 1.17 : interline;
  const offsetX = style.thickness / 1.52;
  let offsetY = style.sizeY - style.thickness * 0.052;
  if (style.valign === "center") offsetY -= height / 2;
  else if (style.valign === "bottom") offsetY -= height;
  const tilt = style.italic ? ITALIC_TILT : 0;
  const out: Vec2[][] = [];
  const place = (p: Vec2): Vec2 => {
    let x = p.x;
    if (style.mirror) x = at.x - (x - at.x);
    const r = rotate({ x: x - at.x, y: p.y - at.y }, angle);
    return { x: r.x + at.x, y: r.y + at.y };
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const width = lineWidth(line, style);
    let cursorX = at.x + offsetX;
    if (style.halign === "center") cursorX -= width / 2;
    else if (style.halign === "right") cursorX -= width;
    const baseY = at.y + li * interline + offsetY;
    for (const ch of line) {
      if (ch === " " || ch === "\t") {
        cursorX += SPACE_ADVANCE * style.sizeX;
        continue;
      }
      const glyph = glyphFor(ch);
      for (const stroke of glyph.strokes) {
        const pts: Vec2[] = new Array(stroke.length);
        for (let i = 0; i < stroke.length; i++) {
          const gx = stroke[i]!.x * style.sizeX;
          const gy = stroke[i]!.y * style.sizeY;
          pts[i] = place({ x: cursorX + gx - gy * tilt, y: baseY + gy });
        }
        out.push(pts);
      }
      cursorX += glyph.advance * style.sizeX;
    }
  }
  return out;
}

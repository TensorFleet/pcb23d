import { describe, expect, test } from "bun:test";
import { boundsOf } from "../src/geometry";
import { glyphFor, lineWidth, textStrokes, type TextStyle } from "../src/font/text";
import { parseBoard } from "../src/kicad/board";

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  sizeX: 1,
  sizeY: 1,
  thickness: 0.15,
  bold: false,
  italic: false,
  halign: "center",
  valign: "center",
  mirror: false,
  ...over,
});

describe("newstroke text", () => {
  test("glyphs have strokes and sensible advances", () => {
    const a = glyphFor("A");
    expect(a.strokes.length).toBeGreaterThan(0);
    expect(a.advance).toBeGreaterThan(0.5);
    expect(a.advance).toBeLessThan(1.2);
    expect(glyphFor("\u{1F600}").strokes.length).toBe(glyphFor("?").strokes.length);
  });
  test("cap height is about the font size and sits above the baseline", () => {
    const pts = glyphFor("H").strokes.flat();
    const b = boundsOf(pts);
    expect(b.maxY - b.minY).toBeCloseTo(1, 0);
    expect(b.minY).toBeLessThan(-0.8);
    expect(b.maxY).toBeLessThan(0.1);
  });
  test("line width grows with characters and size", () => {
    expect(lineWidth("AB", style())).toBeGreaterThan(lineWidth("A", style()));
    expect(lineWidth("AB", style({ sizeX: 2 }))).toBeCloseTo(lineWidth("AB", style()) * 2, 1);
  });
  test("centered text straddles the anchor; mirror flips x; rotation turns it", () => {
    const at = { x: 10, y: 20 };
    const plain = boundsOf(textStrokes("R1", at, 0, style()).flat());
    expect((plain.minX + plain.maxX) / 2).toBeCloseTo(10, 0);
    expect((plain.minY + plain.maxY) / 2).toBeCloseTo(20, 0);
    const first = textStrokes("R1", at, 0, style())[0]![0]!;
    const mirrored = textStrokes("R1", at, 0, style({ mirror: true }))[0]![0]!;
    expect(mirrored.x - 10).toBeCloseTo(-(first.x - 10), 5);
    const rot = boundsOf(textStrokes("RRRR", at, 90, style()).flat());
    expect(rot.maxY - rot.minY).toBeGreaterThan(rot.maxX - rot.minX);
  });
  test("left/bottom justification puts the anchor at the start of the text", () => {
    const b = boundsOf(textStrokes("ABC", { x: 0, y: 0 }, 0, style({ halign: "left", valign: "bottom" })).flat());
    expect(b.minX).toBeGreaterThan(-0.2);
    expect(b.maxY).toBeLessThan(0.2);
  });
});

describe("board text", () => {
  const board = `(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
    (gr_text "STATUS" (at 5 5 0) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.15))))
    (gr_text "hidden layer" (at 5 5 0) (layer "Cmts.User") (effects (font (size 1 1))))
    (footprint "R:R_0402" (layer "F.Cu") (at 20 20 90)
      (property "Reference" "R7" (at 0 -1.2 90) (layer "F.SilkS") (effects (font (size 0.7 0.7) (thickness 0.1))))
      (property "Value" "10k" (at 0 1.2 90) (layer "F.Fab") (hide yes) (effects (font (size 0.7 0.7))))
      (fp_text user "\${REFERENCE}" (at 0 0 90) (layer "F.Fab") hide (effects (font (size 0.5 0.5))))
      (pad "1" smd rect (at -0.5 0 90) (size 0.5 0.5) (layers "F.Cu" "F.Mask")))
    (gr_rect (start 0 0) (end 40 40) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`;
  test("silkscreen text becomes shapes on its layer, hidden and non-rendered layers do not", () => {
    const b = parseBoard(board);
    const silk = b.shapes.get("F.SilkS") ?? [];
    expect(silk.length).toBeGreaterThan(10);
    expect(b.shapes.has("Cmts.User")).toBe(false);
    expect(b.shapes.has("F.Fab")).toBe(false);
    // the reference "R7" sits near the rotated footprint: local (0,-1.2) rotated 90° CCW → world (20-1.2, 20)
    const ref = boundsOf(silk.slice(-6).flat());
    expect(ref.minX).toBeGreaterThan(17);
    expect(ref.maxX).toBeLessThan(21);
  });
});

import { describe, expect, test } from "bun:test";
import { buildOutline, parseBoard } from "../src/kicad/board";
import { estimateHeight, isBodilessFootprint } from "../src/kicad/heights";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("parseBoard", () => {
  test("reads the ecc83 demo: outline, layers, pads, components", async () => {
    const board = parseBoard(await fixture("ecc83-pp.kicad_pcb"));
    expect(board.version).toBe(20241229);
    expect(board.thickness).toBe(1.6);
    expect(board.copperLayers).toEqual(["F.Cu", "B.Cu"]);
    expect(board.outlineFromEdgeCuts).toBe(true);
    expect(board.outline).toHaveLength(1);
    expect(board.bounds.maxX - board.bounds.minX).toBeGreaterThan(40);
    expect(board.stats.footprints).toBe(15);
    expect(board.stats.pads).toBeGreaterThan(20);
    expect(board.shapes.get("B.Cu")!.length).toBeGreaterThan(10);
    expect(board.shapes.get("F.Mask")!.length).toBeGreaterThan(0);
    expect(board.holes.length).toBeGreaterThan(10);
    expect(board.components.length).toBeGreaterThan(5);
    expect(board.stackup.maskColor).toBe("Green");
  });
  test("reads the constraints demo", async () => {
    const board = parseBoard(await fixture("constraints.kicad_pcb"));
    expect(board.outline.length).toBeGreaterThan(0);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
  });
  test("falls back to content bounds without Edge.Cuts", () => {
    const board = parseBoard(
      '(kicad_pcb (version 20221018) (general (thickness 1.2)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (segment (start 0 0) (end 10 0) (width 0.5) (layer "F.Cu") (net 0)))',
    );
    expect(board.outlineFromEdgeCuts).toBe(false);
    expect(board.thickness).toBe(1.2);
    expect(board.bounds.minX).toBeLessThan(0);
    expect(board.bounds.maxX).toBeGreaterThan(10);
  });
  test("footprint pads land at the rotated world position", () => {
    const board = parseBoard(`(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Test:R" (layer "F.Cu") (at 100 50 90)
        (fp_line (start -1 -1) (end 1 1) (layer "F.Fab") (stroke (width 0.1) (type solid)))
        (pad "1" smd rect (at 2 0 90) (size 1 1) (layers "F.Cu" "F.Mask")))
      (gr_rect (start 90 40) (end 110 60) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`);
    const pad = board.shapes.get("F.Cu")![0]!;
    const cx = pad.reduce((s, p) => s + p.x, 0) / pad.length;
    const cy = pad.reduce((s, p) => s + p.y, 0) / pad.length;
    expect(cx).toBeCloseTo(100);
    expect(cy).toBeCloseTo(48); // +x local rotated 90° CCW on screen points up (−y)
    expect(board.components).toHaveLength(1);
    expect(board.components[0]!.side).toBe("front");
    expect(board.outline[0]!.outer).toHaveLength(4);
  });
  test("rejects non-board input", () => {
    expect(() => parseBoard("(kicad_sch (version 1))")).toThrow(/not a KiCad board/);
  });
});

describe("buildOutline", () => {
  test("chains segments into a ring and nests cut-outs as holes", () => {
    const sq = (x: number, y: number, s: number) => [
      [{ x, y }, { x: x + s, y }],
      [{ x: x + s, y }, { x: x + s, y: y + s }],
      [{ x: x + s, y: y + s }, { x, y: y + s }],
      [{ x, y: y + s }, { x, y }],
    ];
    const polys = buildOutline([...sq(0, 0, 20), ...sq(5, 5, 4)], []);
    expect(polys).toHaveLength(1);
    expect(polys[0]!.outer).toHaveLength(4);
    expect(polys[0]!.holes).toHaveLength(1);
  });
  test("keeps two separate boards separate", () => {
    const polys = buildOutline([], [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }],
    ]);
    expect(polys).toHaveLength(2);
  });
});

describe("heights", () => {
  test("reads IPC-7351 heights and known package families", () => {
    expect(estimateHeight("RESC1005X40N", 1, 0.5)).toBeCloseTo(0.4);
    expect(estimateHeight("SOIC127P600X175-8N", 6, 5)).toBeCloseTo(1.75);
    expect(estimateHeight("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", 4, 5)).toBeCloseTo(1.4);
    expect(estimateHeight("Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", 2.5, 10)).toBe(8.5);
    expect(estimateHeight("Capacitor_THT:CP_Radial_D6.3mm_P2.50mm", 6.3, 6.3)).toBeCloseTo(6.3);
    expect(estimateHeight("Unknown:Thing", 10, 10)).toBeGreaterThan(0.5);
  });
  test("skips holes and test points", () => {
    expect(isBodilessFootprint("MountingHole:MountingHole_3.2mm_M3")).toBe(true);
    expect(isBodilessFootprint("TestPoint:TestPoint_Pad_D1.5mm")).toBe(true);
    expect(isBodilessFootprint("Resistor_SMD:R_0402_1005Metric")).toBe(false);
  });
});

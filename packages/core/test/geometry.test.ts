import { describe, expect, test } from "bun:test";
import {
  arcFromThreePoints,
  arcPoints,
  boundsOf,
  offsetRing,
  rect,
  ringArea,
  rotate,
  roundRect,
  strokeSegment,
} from "../src/geometry";

describe("geometry", () => {
  test("rotate follows KiCad's screen-space counter-clockwise convention", () => {
    const p = rotate({ x: 1, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-1);
  });
  test("three-point arc passes through the mid point", () => {
    const arc = arcFromThreePoints({ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 });
    expect(arc).not.toBeNull();
    expect(arc!.radius).toBeCloseTo(1);
    const pts = arcPoints(arc!);
    const hit = pts.some((p) => Math.hypot(p.x - 1, p.y) < 0.05);
    expect(hit).toBe(true);
    expect(Math.abs(arc!.sweep)).toBeCloseTo(Math.PI);
  });
  test("collinear points do not make an arc", () => {
    expect(arcFromThreePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });
  test("stroke segment covers its width", () => {
    const [ring] = strokeSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 2);
    const b = boundsOf(ring!);
    expect(b.minX).toBeCloseTo(-1, 1);
    expect(b.maxX).toBeCloseTo(11, 1);
    expect(b.minY).toBeCloseTo(-1, 1);
    expect(b.maxY).toBeCloseTo(1, 1);
  });
  test("roundRect stays within the rectangle", () => {
    const b = boundsOf(roundRect(4, 2, 0.5));
    expect(b.minX).toBeCloseTo(-2);
    expect(b.maxY).toBeCloseTo(1);
  });
  test("offsetRing grows a rectangle outward regardless of winding", () => {
    const r = rect({ x: 0, y: 0 }, 2, 2);
    for (const ring of [r, [...r].reverse()]) {
      const grown = offsetRing(ring, 0.5);
      const b = boundsOf(grown);
      expect(b.minX).toBeCloseTo(-1.5, 1);
      expect(b.maxX).toBeCloseTo(1.5, 1);
      expect(Math.abs(ringArea(grown))).toBeGreaterThan(Math.abs(ringArea(ring)));
    }
  });
});

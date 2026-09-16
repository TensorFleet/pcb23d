/**
 * Scanline polygon rasterizer producing anti-aliased coverage (0..1) into a Float32Array.
 * Uses the non-zero winding rule within one call and 4 vertical sub-samples per pixel with
 * exact horizontal span coverage, so abutting shapes (fractured zone fills, chained tracks)
 * add up to full coverage without seams.
 */
import type { Ring, Vec2 } from "./geometry";

export interface CoverageMap {
  width: number;
  height: number;
  data: Float32Array;
}

export function createCoverage(width: number, height: number): CoverageMap {
  return { width, height, data: new Float32Array(width * height) };
}

/** Maps board millimetres to texture pixels. */
export interface PixelTransform {
  /** pixels per mm */
  scale: number;
  /** mm offset subtracted before scaling */
  originX: number;
  originY: number;
  /** flip x so the bottom face reads correctly when viewed from below */
  mirrorX: boolean;
  width: number;
}

export function toPixel(t: PixelTransform, p: Vec2): [number, number] {
  let x = (p.x - t.originX) * t.scale;
  if (t.mirrorX) x = t.width - x;
  return [x, (p.y - t.originY) * t.scale];
}

const SUB = 4;

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: number;
}

/** Add the coverage of one polygon (outer ring plus optional holes) into `cov`. */
export function fillRings(cov: CoverageMap, rings: Ring[], t: PixelTransform, weight = 1): void {
  const edges: Edge[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = toPixel(t, ring[i]!);
      const [bx, by] = toPixel(t, ring[(i + 1) % n]!);
      if (ay === by) continue;
      if (ay < by) edges.push({ x0: ax, y0: ay, x1: bx, y1: by, dir: 1 });
      else edges.push({ x0: bx, y0: by, x1: ax, y1: ay, dir: -1 });
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }
  if (edges.length === 0) return;
  const { width, height, data } = cov;
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(height - 1, Math.ceil(maxY));
  if (yStart > yEnd) return;
  edges.sort((a, b) => a.y0 - b.y0);
  const xs: { x: number; dir: number }[] = [];
  const row = new Float32Array(width + 2);
  const subWeight = weight / SUB;
  let nextEdge = 0;
  const active: Edge[] = [];
  for (let py = yStart; py <= yEnd; py++) {
    row.fill(0);
    let touched = false;
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB;
      while (nextEdge < edges.length && edges[nextEdge]!.y0 <= sy) active.push(edges[nextEdge++]!);
      xs.length = 0;
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i]!;
        if (e.y1 <= sy) {
          active[i] = active[active.length - 1]!;
          active.pop();
          continue;
        }
        if (e.y0 > sy) continue;
        const x = e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0);
        xs.push({ x, dir: e.dir });
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i]!.dir;
        if (wind === 0) continue;
        const xa = Math.max(0, xs[i]!.x);
        const xb = Math.min(width, xs[i + 1]!.x);
        if (xb <= xa) continue;
        touched = true;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        if (ia === ib) {
          row[ia]! += (xb - xa) * subWeight;
        } else {
          row[ia]! += (ia + 1 - xa) * subWeight;
          for (let x = ia + 1; x < ib; x++) row[x]! += subWeight;
          if (ib < width) row[ib]! += (xb - ib) * subWeight;
        }
      }
    }
    if (!touched) continue;
    const base = py * width;
    for (let x = 0; x < width; x++) {
      const v = row[x]!;
      if (v !== 0) {
        const nv = data[base + x]! + v;
        data[base + x] = nv > 1 ? 1 : nv;
      }
    }
  }
}

/** Fill many independent rings (union) into a fresh coverage map. */
export function rasterizeRings(rings: Ring[], t: PixelTransform, width: number, height: number): CoverageMap {
  const cov = createCoverage(width, height);
  for (const r of rings) fillRings(cov, [r], t);
  return cov;
}

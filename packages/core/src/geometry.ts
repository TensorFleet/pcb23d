/** 2D helpers in KiCad board units (mm, y grows downward). */
export interface Vec2 {
  x: number;
  y: number;
}

/** A closed ring of points. Orientation is not enforced. */
export type Ring = Vec2[];

/** A polygon with one outer ring and zero or more hole rings. */
export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const DEG = Math.PI / 180;

/** KiCad rotates counter-clockwise on screen; with y down that is this matrix. */
export function rotate(p: Vec2, degrees: number): Vec2 {
  if (degrees === 0) return { x: p.x, y: p.y };
  const a = degrees * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extendBounds(b: Bounds, p: Vec2): void {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

export function boundsOf(points: Iterable<Vec2>): Bounds {
  const b = emptyBounds();
  for (const p of points) extendBounds(b, p);
  return b;
}

export function boundsValid(b: Bounds): boolean {
  return Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX > b.minX && b.maxY > b.minY;
}

export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j]!.x + ring[i]!.x) * (ring[j]!.y - ring[i]!.y);
  }
  return a / 2;
}

/** Number of segments used to approximate a full circle of radius r (mm). */
export function circleSegments(r: number, quality = 1): number {
  return Math.max(12, Math.min(96, Math.ceil(Math.sqrt(r * 800) * quality)));
}

export function circle(center: Vec2, r: number, segments = circleSegments(r)): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return ring;
}

/** Axis-aligned or rotated rectangle centred on `c`, rotated `rot` degrees (KiCad convention). */
export function rect(c: Vec2, w: number, h: number, rot = 0): Ring {
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((p) => add(rotate(p, rot), c));
}

/** Rectangle with rounded corners of radius r, centred at origin. */
export function roundRect(w: number, h: number, r: number, cornerSegs = 6): Ring {
  const hw = w / 2;
  const hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  if (r <= 1e-6) return rect({ x: 0, y: 0 }, w, h);
  const ring: Ring = [];
  const corners: [number, number, number][] = [
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, 90],
    [-hw + r, -hh + r, 180],
    [hw - r, -hh + r, 270],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = ((start + (90 * i) / cornerSegs) * Math.PI) / 180;
      ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return ring;
}

/** Oval (stadium) of size w×h centred at origin. */
export function oval(w: number, h: number): Ring {
  return roundRect(w, h, Math.min(w, h) / 2, 10);
}

/** Polygon for a stroked polyline (round caps and joins). */
export function strokePolyline(points: Vec2[], width: number): Ring[] {
  const r = width / 2;
  if (points.length === 1) return [circle(points[0]!, r)];
  const rings: Ring[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    rings.push(...strokeSegment(points[i]!, points[i + 1]!, width));
  }
  return rings;
}

/** Polygon(s) for a stroked segment with round caps. */
export function strokeSegment(a: Vec2, b: Vec2, width: number): Ring[] {
  const r = width / 2;
  if (r <= 0) return [];
  const d = sub(b, a);
  const len = length(d);
  if (len < 1e-9) return [circle(a, r)];
  const nx = (-d.y / len) * r;
  const ny = (d.x / len) * r;
  const segs = Math.max(4, Math.ceil(circleSegments(r) / 2));
  const ring: Ring = [];
  const baseAngle = Math.atan2(ny, nx);
  // cap at b: from +n around to -n through the direction of d
  for (let i = 0; i <= segs; i++) {
    const ang = baseAngle - (Math.PI * i) / segs;
    ring.push({ x: b.x + r * Math.cos(ang), y: b.y + r * Math.sin(ang) });
  }
  for (let i = 0; i <= segs; i++) {
    const ang = baseAngle + Math.PI - (Math.PI * i) / segs;
    ring.push({ x: a.x + r * Math.cos(ang), y: a.y + r * Math.sin(ang) });
  }
  return [ring];
}

export interface ArcDef {
  center: Vec2;
  radius: number;
  startAngle: number; // radians
  sweep: number; // radians, signed
}

/** Circle through three points (KiCad start/mid/end arcs). Returns null when collinear. */
export function arcFromThreePoints(start: Vec2, mid: Vec2, end: Vec2): ArcDef | null {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const center = { x: ux, y: uy };
  const radius = distance(center, start);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const a1 = Math.atan2(by - uy, bx - ux);
  const a2r = Math.atan2(cy - uy, cx - ux);
  // choose sweep direction so that mid lies on the arc
  let sweep = norm(a2r - a0);
  const midSweep = norm(a1 - a0);
  if (midSweep > sweep) sweep -= Math.PI * 2; // go the other way
  return { center, radius, startAngle: a0, sweep };
}

function norm(a: number): number {
  a %= Math.PI * 2;
  if (a < 0) a += Math.PI * 2;
  return a;
}

/** Sample an arc into a polyline (including both endpoints). */
export function arcPoints(arc: ArcDef, maxSegAngle = (Math.PI * 2) / 48): Vec2[] {
  const n = Math.max(2, Math.ceil(Math.abs(arc.sweep) / maxSegAngle));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = arc.startAngle + (arc.sweep * i) / n;
    pts.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
  }
  return pts;
}

/** KiCad legacy arcs: (start = centre) (end = arc start) (angle sweep degrees). */
export function legacyArcPoints(center: Vec2, start: Vec2, angleDeg: number): Vec2[] {
  const radius = distance(center, start);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  return arcPoints({ center, radius, startAngle: a0, sweep: angleDeg * DEG });
}

/** Point-in-ring test (even-odd). */
export function pointInRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Grow a convex-ish ring outward by `d` mm (used for solder-mask expansion). */
export function offsetRing(ring: Ring, d: number): Ring {
  if (d === 0 || ring.length < 3) return ring;
  const sign = ringArea(ring) > 0 ? 1 : -1;
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const n1 = edgeNormal(prev, cur, sign);
    const n2 = edgeNormal(cur, next, sign);
    let bx = n1.x + n2.x;
    let by = n1.y + n2.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      out.push({ x: cur.x + n1.x * d, y: cur.y + n1.y * d });
      continue;
    }
    bx /= bl;
    by /= bl;
    const cosHalf = bx * n1.x + by * n1.y;
    const k = d / Math.max(0.35, cosHalf);
    out.push({ x: cur.x + bx * k, y: cur.y + by * k });
  }
  return out;
}

function edgeNormal(a: Vec2, b: Vec2, sign: number): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: (-sign * dy) / l, y: (sign * dx) / l };
}

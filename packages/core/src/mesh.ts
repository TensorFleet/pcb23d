/**
 * Builds a triangle soup for the board slab (textured top/bottom, solid edges) and component
 * boxes. World units are millimetres: x east, y north (KiCad y negated), z up; the board is
 * centred on the origin with its mid-plane at z = 0.
 */
import earcut from "earcut";
import type { Palette, RGB } from "./color";
import type { Ring, Vec2 } from "./geometry";
import { ringArea } from "./geometry";
import type { Board, Component } from "./kicad/board";
import type { ModelMesh } from "./models/vrml";
import type { Texture } from "./texture";

export type Material = { kind: "texture"; texture: Texture } | { kind: "color"; rgb: RGB };

export interface Mesh {
  /** 15 floats per triangle: ax ay az bx by bz cx cy cz au av bu bv cu cv */
  tris: Float32Array;
  material: Uint16Array;
  materials: Material[];
  count: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

class MeshBuilder {
  private tris: number[] = [];
  private mats: number[] = [];
  readonly materials: Material[] = [];
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  material(m: Material): number {
    this.materials.push(m);
    return this.materials.length - 1;
  }

  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    mat: number,
    uv: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0],
  ): void {
    this.tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], ...uv);
    this.mats.push(mat);
    for (const p of [a, b, c]) {
      for (let i = 0; i < 3; i++) {
        if (p[i]! < this.min[i]!) this.min[i] = p[i]!;
        if (p[i]! > this.max[i]!) this.max[i] = p[i]!;
      }
    }
  }

  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    mat: number,
  ): void {
    this.tri(a, b, c, mat);
    this.tri(a, c, d, mat);
  }

  build(): Mesh {
    return {
      tris: new Float32Array(this.tris),
      material: new Uint16Array(this.mats),
      materials: this.materials,
      count: this.mats.length,
      bounds: { min: this.min, max: this.max },
    };
  }
}

export interface MeshOptions {
  components?: boolean;
  /** Converted 3D models keyed by library path; components without one fall back to boxes. */
  models?: Map<string, ModelMesh>;
}

export function buildMesh(
  board: Board,
  topTexture: Texture,
  bottomTexture: Texture,
  palette: Palette,
  opts: MeshOptions = {},
): Mesh {
  const mb = new MeshBuilder();
  const b = board.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const t = board.thickness;
  const zTop = t / 2;
  const zBot = -t / 2;
  const toWorld = (p: Vec2, z: number): [number, number, number] => [p.x - cx, -(p.y - cy), z];
  const uv = (p: Vec2): [number, number] => [(p.x - b.minX) / bw, (p.y - b.minY) / bh];

  const matTop = mb.material({ kind: "texture", texture: topTexture });
  const matBottom = mb.material({ kind: "texture", texture: bottomTexture });
  const matEdge = mb.material({ kind: "color", rgb: palette.edge });
  const matBody = mb.material({ kind: "color", rgb: palette.component });

  for (const poly of board.outline) {
    const rings = [poly.outer, ...poly.holes];
    const flat: number[] = [];
    const holeIdx: number[] = [];
    for (let i = 0; i < rings.length; i++) {
      if (i > 0) holeIdx.push(flat.length / 2);
      for (const p of rings[i]!) flat.push(p.x, p.y);
    }
    const idx = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    const pt = (i: number): Vec2 => ({ x: flat[i * 2]!, y: flat[i * 2 + 1]! });
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const p0 = pt(idx[i]!);
      const p1 = pt(idx[i + 1]!);
      const p2 = pt(idx[i + 2]!);
      const [u0, v0] = uv(p0);
      const [u1, v1] = uv(p1);
      const [u2, v2] = uv(p2);
      mb.tri(toWorld(p0, zTop), toWorld(p1, zTop), toWorld(p2, zTop), matTop, [u0, v0, u1, v1, u2, v2]);
      mb.tri(toWorld(p0, zBot), toWorld(p2, zBot), toWorld(p1, zBot), matBottom, [u0, v0, u2, v2, u1, v1]);
    }
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        mb.quad(toWorld(p, zBot), toWorld(q, zBot), toWorld(q, zTop), toWorld(p, zTop), matEdge);
      }
    }
  }

  if (opts.components ?? true) {
    const boardArea = bw * bh;
    const materialCache = new Map<string, number>();
    for (const comp of board.components) {
      const model = pickModel(comp, opts.models);
      if (model) {
        addModel(mb, comp, model.mesh, model.ref, comp.side === "front" ? zTop : zBot, toWorld, materialCache);
        continue;
      }
      if (comp.boxless) continue;
      const area = Math.abs(ringArea(comp.outline));
      if (area > boardArea * 0.6) continue;
      const base = comp.side === "front" ? zTop : zBot;
      const top = comp.side === "front" ? zTop + comp.height : zBot - comp.height;
      addBox(mb, comp.outline, base, top, matBody, toWorld);
    }
  }

  return mb.build();
}

function pickModel(comp: Component, models: Map<string, ModelMesh> | undefined): { mesh: ModelMesh; ref: Component["models"][number] } | null {
  if (!models) return null;
  for (const ref of comp.models) {
    if (ref.hide || !ref.key) continue;
    const mesh = models.get(ref.key);
    if (mesh && mesh.triangles > 0) return { mesh, ref };
  }
  return null;
}

/**
 * Place a library model: KiCad applies scale, then rotations about X, Y, Z (negated angles),
 * then the offset, in a right-handed frame with X east, Y north, Z up. Then the footprint
 * rotation about Z; back-side footprints are turned 180° about X so they hang under the board.
 */
function addModel(
  mb: MeshBuilder,
  comp: Component,
  mesh: ModelMesh,
  ref: Component["models"][number],
  surfaceZ: number,
  toWorld: (p: Vec2, z: number) => [number, number, number],
  materialCache: Map<string, number>,
): void {
  const [sx, sy, sz] = ref.scale;
  const rx = (-ref.rotate[0] * Math.PI) / 180;
  const ry = (-ref.rotate[1] * Math.PI) / 180;
  const rz = (-ref.rotate[2] * Math.PI) / 180;
  const fpRot = (comp.rotation * Math.PI) / 180;
  const back = comp.side === "back";
  const origin = toWorld(comp.at, surfaceZ);
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const cosZ = Math.cos(rz), sinZ = Math.sin(rz);
  const cosF = Math.cos(fpRot), sinF = Math.sin(fpRot);
  const place = (x: number, y: number, z: number): [number, number, number] => {
    x *= sx;
    y *= sy;
    z *= sz;
    // rotate X
    let y1 = y * cosX - z * sinX;
    let z1 = y * sinX + z * cosX;
    // rotate Y
    let x2 = x * cosY + z1 * sinY;
    let z2 = -x * sinY + z1 * cosY;
    // rotate Z
    let x3 = x2 * cosZ - y1 * sinZ;
    let y3 = x2 * sinZ + y1 * cosZ;
    x3 += ref.offset[0];
    y3 += ref.offset[1];
    z2 += ref.offset[2];
    if (back) {
      y3 = -y3;
      z2 = -z2;
    }
    const wx = x3 * cosF - y3 * sinF;
    const wy = x3 * sinF + y3 * cosF;
    return [origin[0] + wx, origin[1] + wy, origin[2] + z2];
  };
  for (const g of mesh.groups) {
    if (g.transparency > 0.9) continue;
    const key = `${g.color.map((c) => Math.round(c)).join(",")}`;
    let mat = materialCache.get(key);
    if (mat === undefined) {
      mat = mb.material({ kind: "color", rgb: [g.color[0], g.color[1], g.color[2]] });
      materialCache.set(key, mat);
    }
    const p = g.positions;
    for (let i = 0; i + 8 < p.length; i += 9) {
      mb.tri(place(p[i]!, p[i + 1]!, p[i + 2]!), place(p[i + 3]!, p[i + 4]!, p[i + 5]!), place(p[i + 6]!, p[i + 7]!, p[i + 8]!), mat);
    }
  }
}

function addBox(
  mb: MeshBuilder,
  ring: Ring,
  z0: number,
  z1: number,
  mat: number,
  toWorld: (p: Vec2, z: number) => [number, number, number],
): void {
  const n = ring.length;
  const cap = ring.map((p) => toWorld(p, z1));
  for (let i = 1; i + 1 < n; i++) mb.tri(cap[0]!, cap[i]!, cap[i + 1]!, mat);
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    mb.quad(toWorld(p, z0), toWorld(q, z0), toWorld(q, z1), toWorld(p, z1), mat);
  }
}

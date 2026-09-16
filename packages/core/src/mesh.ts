/**
 * Builds a triangle soup for the board slab (textured top/bottom, solid edges) and component
 * boxes. World units are millimetres: x east, y north (KiCad y negated), z up; the board is
 * centred on the origin with its mid-plane at z = 0.
 */
import earcut from "earcut";
import type { Palette, RGB } from "./color";
import type { Ring, Vec2 } from "./geometry";
import { ringArea } from "./geometry";
import type { Board } from "./kicad/board";
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
    for (const comp of board.components) {
      const area = Math.abs(ringArea(comp.outline));
      if (area > boardArea * 0.6) continue;
      const base = comp.side === "front" ? zTop : zBot;
      const top = comp.side === "front" ? zTop + comp.height : zBot - comp.height;
      addBox(mb, comp.outline, base, top, matBody, toWorld);
    }
  }

  return mb.build();
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

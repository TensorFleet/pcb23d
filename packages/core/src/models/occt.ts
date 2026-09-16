/**
 * Adapter for occt-import-js (OpenCascade compiled to WebAssembly): turns its STEP import result
 * into a ModelMesh. The WASM itself is loaded by the host (browser worker or CLI) because it is
 * 7 MB and only needed for STEP-only project models.
 */
import type { ModelMesh, MeshGroup } from "./vrml";

export interface OcctFaceLike {
  /** First and last triangle index (inclusive) of this B-rep face. */
  first: number;
  last: number;
  color?: ArrayLike<number>;
}

export interface OcctMeshLike {
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
  /** Mesh-level colour (rare in KiCad library STEPs, which colour per face). */
  color?: ArrayLike<number>;
  /** Per-face colour ranges; KiCad library STEPs carry their colours here. */
  brep_faces?: OcctFaceLike[];
}

export interface OcctResultLike {
  success: boolean;
  meshes: OcctMeshLike[];
}

export interface OcctModuleLike {
  ReadStepFile(bytes: Uint8Array, params: { linearDeflection?: number; angularDeflection?: number } | null): OcctResultLike;
}

export const OCCT_PARAMS = { linearDeflection: 0.05, angularDeflection: 0.4 };

const DEFAULT_STEP_COLOR: [number, number, number] = [0.6 * 255, 0.6 * 255, 0.6 * 255];

/** Convert an occt-import-js result (millimetres) into colour-grouped triangles. */
export function meshFromOcct(result: OcctResultLike): ModelMesh | null {
  if (!result.success) return null;
  const groups = new Map<string, { color: [number, number, number]; tris: number[] }>();
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const toRgb = (c: ArrayLike<number> | undefined, fallback: [number, number, number]): [number, number, number] =>
    c && c.length >= 3 ? [c[0]! * 255, c[1]! * 255, c[2]! * 255] : fallback;
  const groupFor = (color: [number, number, number]) => {
    const key = color.map((c) => Math.round(c)).join(",");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { color, tris: [] }));
    return g;
  };
  for (const m of result.meshes) {
    const pos = m.attributes.position.array;
    const meshColor = toRgb(m.color, DEFAULT_STEP_COLOR);
    const idx = m.index?.array;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
    // colour per triangle: face ranges win, then the mesh colour
    const faceColor = new Array<[number, number, number] | undefined>(triCount);
    for (const f of m.brep_faces ?? []) {
      if (!f.color) continue;
      const c = toRgb(f.color, meshColor);
      for (let t = Math.max(0, f.first); t <= Math.min(f.last, triCount - 1); t++) faceColor[t] = c;
    }
    const pushVertex = (g: { tris: number[] }, i: number) => {
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      g.tris.push(x, y, z);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    };
    for (let t = 0; t < triCount; t++) {
      const g = groupFor(faceColor[t] ?? meshColor);
      if (idx) {
        pushVertex(g, idx[t * 3]!);
        pushVertex(g, idx[t * 3 + 1]!);
        pushVertex(g, idx[t * 3 + 2]!);
      } else {
        pushVertex(g, t * 3);
        pushVertex(g, t * 3 + 1);
        pushVertex(g, t * 3 + 2);
      }
      triangles++;
    }
  }
  if (triangles === 0) return null;
  const out: MeshGroup[] = [];
  for (const g of groups.values()) out.push({ color: g.color, transparency: 0, positions: new Float32Array(g.tris) });
  return { groups: out, triangles, bounds: { min, max } };
}

/** A `convertStep` implementation over a loaded occt-import-js module. */
export function occtStepConverter(occt: OcctModuleLike): (bytes: Uint8Array) => Promise<ModelMesh | null> {
  return async (bytes) => {
    try {
      return meshFromOcct(occt.ReadStepFile(bytes, OCCT_PARAMS));
    } catch {
      return null;
    }
  };
}

export function isStepPath(path: string): boolean {
  return /\.(step|stp)$/i.test(path);
}

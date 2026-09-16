/**
 * Adapter for occt-import-js (OpenCascade compiled to WebAssembly): turns its STEP import result
 * into a ModelMesh. The WASM itself is loaded by the host (browser worker or CLI) because it is
 * 7 MB and only needed for STEP-only project models.
 */
import type { ModelMesh, MeshGroup } from "./vrml";

export interface OcctMeshLike {
  attributes: { position: { array: ArrayLike<number> } };
  index?: { array: ArrayLike<number> };
  color?: ArrayLike<number>;
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
  for (const m of result.meshes) {
    const pos = m.attributes.position.array;
    const color: [number, number, number] = m.color
      ? [m.color[0]! * 255, m.color[1]! * 255, m.color[2]! * 255]
      : DEFAULT_STEP_COLOR;
    const key = color.map((c) => Math.round(c)).join(",");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { color, tris: [] }));
    const push = (i: number) => {
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      g!.tris.push(x, y, z);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    };
    if (m.index) {
      const idx = m.index.array;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        push(idx[i]!);
        push(idx[i + 1]!);
        push(idx[i + 2]!);
        triangles++;
      }
    } else {
      const n = Math.floor(pos.length / 9) * 3;
      for (let i = 0; i < n; i++) push(i);
      triangles += n / 3;
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

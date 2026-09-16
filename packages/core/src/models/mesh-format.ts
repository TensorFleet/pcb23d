/**
 * Compact binary cache format for converted models: little-endian,
 * magic "P23M", u32 version, u32 groupCount, then per group
 * f32 r g b transparency, u32 triangleCount, f32[triangleCount*9] positions (mm).
 */
import type { ModelMesh, MeshGroup } from "./vrml";

const MAGIC = 0x4d333250; // "P23M"
const VERSION = 1;

export function encodeMesh(mesh: ModelMesh): Uint8Array {
  let bytes = 12;
  for (const g of mesh.groups) bytes += 20 + g.positions.byteLength;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  let o = 0;
  view.setUint32(o, MAGIC, true);
  view.setUint32(o + 4, VERSION, true);
  view.setUint32(o + 8, mesh.groups.length, true);
  o = 12;
  for (const g of mesh.groups) {
    view.setFloat32(o, g.color[0], true);
    view.setFloat32(o + 4, g.color[1], true);
    view.setFloat32(o + 8, g.color[2], true);
    view.setFloat32(o + 12, g.transparency, true);
    view.setUint32(o + 16, g.positions.length / 9, true);
    o += 20;
    new Uint8Array(buf, o, g.positions.byteLength).set(new Uint8Array(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength));
    o += g.positions.byteLength;
  }
  return new Uint8Array(buf);
}

export function decodeMesh(bytes: Uint8Array): ModelMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== MAGIC) throw new Error("not a pcb23d mesh");
  if (view.getUint32(4, true) !== VERSION) throw new Error("unsupported mesh version");
  const count = view.getUint32(8, true);
  let o = 12;
  const groups: MeshGroup[] = [];
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const color: [number, number, number] = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
    const transparency = view.getFloat32(o + 12, true);
    const tris = view.getUint32(o + 16, true);
    o += 20;
    const positions = new Float32Array(tris * 9);
    // copy (source may be unaligned)
    new Uint8Array(positions.buffer).set(bytes.subarray(o, o + tris * 36));
    o += tris * 36;
    for (let j = 0; j < positions.length; j += 3)
      for (let k = 0; k < 3; k++) {
        const v = positions[j + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    triangles += tris;
    groups.push({ color, transparency, positions });
  }
  return { groups, triangles, bounds: { min, max } };
}

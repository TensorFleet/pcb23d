/**
 * EasyEDA / LCSC part models. Footprints exported through JLCPCB tooling usually carry an
 * `LCSC` (or `LCSC Part`) property with a C-number; EasyEDA publishes an OBJ model for most of
 * those parts. Placement follows easyeda2kicad: canvas units are 10 mil, the model is centred
 * on its XY bounding box with its base at z = 0, then the footprint's `c_origin`/`z` offset and
 * `c_rotation` apply as KiCad offset/rotate.
 */
import type { ModelMesh, MeshGroup } from "./vrml";

export const EASYEDA_CANVAS_MM = 0.254; // 10 mil per canvas unit
export const EASYEDA_COMPONENT_API = "https://easyeda.com/api/products";
export const EASYEDA_MODEL_BASE = "https://modules.easyeda.com/3dmodel";
export const LCSC_KEY_PREFIX = "lcsc:";

const LCSC_PROPERTY_NAMES = ["LCSC", "LCSC Part", "LCSC Part #", "LCSC#", "LCSC_PART", "JLCPCB Part", "JLCPCB", "JLC", "JLC Part", "Supplier Part"];

/** The LCSC C-number on a footprint, if any. */
export function lcscFromProperties(properties: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(properties)) {
    const norm = name.trim().toLowerCase().replace(/[\s_#.-]+/g, " ").trim();
    if (!LCSC_PROPERTY_NAMES.some((n) => n.toLowerCase().replace(/[\s_#.-]+/g, " ").trim() === norm)) continue;
    const m = /^\s*(C\d{2,9})\s*$/i.exec(value);
    if (m) return m[1]!.toUpperCase();
  }
  return undefined;
}

export interface EasyedaModelInfo {
  lcsc: string;
  uuid: string;
  title: string;
  /** KiCad-style offset in mm and rotation in degrees for the normalised mesh. */
  offset: [number, number, number];
  rotate: [number, number, number];
}

/** Pull the 3D model reference out of an EasyEDA `products/<C>/components` response. */
export function parseEasyedaComponent(json: unknown, lcsc: string): EasyedaModelInfo | null {
  const result = (json as { result?: Record<string, unknown> } | null)?.result;
  const pkg = result?.packageDetail as { dataStr?: { head?: Record<string, unknown>; shape?: string[] } } | undefined;
  const ds = pkg?.dataStr;
  if (!ds?.shape) return null;
  const head = ds.head ?? {};
  const canvasX = Number(head.x ?? 0) || 0;
  const canvasY = Number(head.y ?? 0) || 0;
  for (const shape of ds.shape) {
    if (!shape.startsWith("SVGNODE")) continue;
    const jsonStart = shape.indexOf("{");
    if (jsonStart < 0) continue;
    let node: { attrs?: Record<string, string> };
    try {
      node = JSON.parse(shape.slice(jsonStart)) as { attrs?: Record<string, string> };
    } catch {
      continue;
    }
    const attrs = node.attrs ?? {};
    const uuid = attrs.uuid;
    if (!uuid || !/^[0-9a-f]{16,64}$/i.test(uuid)) continue;
    const [ox = "0", oy = "0"] = (attrs.c_origin ?? "0,0").split(",");
    const [rx = "0", ry = "0", rz = "0"] = (attrs.c_rotation ?? "0,0,0").split(",");
    const tx = (Number(ox) - canvasX) * EASYEDA_CANVAS_MM;
    const ty = -(Number(oy) - canvasY) * EASYEDA_CANVAS_MM;
    const tz = Number(attrs.z ?? 0) * EASYEDA_CANVAS_MM;
    return {
      lcsc,
      uuid,
      title: attrs.title ?? lcsc,
      offset: [round(tx), round(ty), round(tz)],
      rotate: [Number(rx) || 0, Number(ry) || 0, Number(rz) || 0],
    };
  }
  return null;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Wavefront OBJ with EasyEDA's inline materials (`newmtl`/`Kd` blocks in the same file).
 * Vertices are millimetres. Faces are fan-triangulated; the mesh is centred on its XY bounding
 * box with the lowest point at z = 0, as easyeda2kicad does before applying the offset.
 */
export function parseEasyedaObj(text: string): ModelMesh | null {
  const verts: number[] = [];
  const materials = new Map<string, [number, number, number]>();
  const groups = new Map<string, { color: [number, number, number]; tris: number[] }>();
  let currentMtl = "";
  let group = groups.get("") ?? null;
  let triangles = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      verts.push(Number(p[1]), Number(p[2]), Number(p[3]));
    } else if (line.startsWith("newmtl ")) {
      currentMtl = line.slice(7).trim();
      // look ahead for Kd
      let kd: [number, number, number] = [0.6, 0.6, 0.6];
      for (let j = li + 1; j < Math.min(lines.length, li + 12); j++) {
        const l = lines[j]!;
        if (l.startsWith("Kd ")) {
          const c = l.split(/\s+/);
          kd = [Number(c[1]), Number(c[2]), Number(c[3])];
          break;
        }
        if (l.startsWith("newmtl ") || l.startsWith("usemtl ")) break;
      }
      materials.set(currentMtl, kd);
    } else if (line.startsWith("usemtl ")) {
      const name = line.slice(7).trim();
      const kd = materials.get(name) ?? [0.6, 0.6, 0.6];
      const color: [number, number, number] = [kd[0] * 255, kd[1] * 255, kd[2] * 255];
      const key = color.map((c) => Math.round(c)).join(",");
      group = groups.get(key) ?? null;
      if (!group) groups.set(key, (group = { color, tris: [] }));
    } else if (line.startsWith("f ")) {
      if (!group) groups.set("", (group = { color: [153, 153, 153], tris: [] }));
      const idx = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((t) => {
          const i = Number(t.split("/")[0]);
          return i < 0 ? verts.length / 3 + i : i - 1;
        });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0]!, idx[k]!, idx[k + 1]!]) {
          group.tris.push(verts[i * 3] ?? 0, verts[i * 3 + 1] ?? 0, verts[i * 3 + 2] ?? 0);
        }
        triangles++;
      }
    }
  }
  if (triangles === 0) return null;
  // normalise: centre XY, base at z = 0
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const g of groups.values())
    for (let i = 0; i < g.tris.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const v = g.tris[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
  const dx = (min[0] + max[0]) / 2;
  const dy = (min[1] + max[1]) / 2;
  const dz = min[2];
  const out: MeshGroup[] = [];
  for (const g of groups.values()) {
    const positions = new Float32Array(g.tris.length);
    for (let i = 0; i < g.tris.length; i += 3) {
      positions[i] = g.tris[i]! - dx;
      positions[i + 1] = g.tris[i + 1]! - dy;
      positions[i + 2] = g.tris[i + 2]! - dz;
    }
    out.push({ color: g.color, transparency: 0, positions });
  }
  return {
    groups: out,
    triangles,
    bounds: { min: [min[0] - dx, min[1] - dy, 0], max: [max[0] - dx, max[1] - dy, max[2] - dz] },
  };
}

export function easyedaComponentUrl(lcsc: string): string {
  return `${EASYEDA_COMPONENT_API}/${encodeURIComponent(lcsc)}/components?version=6.4.19.5`;
}

export function easyedaModelUrl(uuid: string): string {
  return `${EASYEDA_MODEL_BASE}/${encodeURIComponent(uuid)}`;
}

/** Resolve and download an LCSC part's model straight from EasyEDA (no cache). */
export async function fetchEasyedaModel(lcsc: string, f: typeof fetch = fetch): Promise<{ info: EasyedaModelInfo; mesh: ModelMesh } | null> {
  const res = await f(easyedaComponentUrl(lcsc), { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const info = parseEasyedaComponent(await res.json(), lcsc);
  if (!info) return null;
  const obj = await f(easyedaModelUrl(info.uuid));
  if (!obj.ok) return null;
  const mesh = parseEasyedaObj(await obj.text());
  return mesh ? { info, mesh } : null;
}

/**
 * LCSC fallback: footprints without a usable library or project model but with an LCSC
 * C-number get EasyEDA's model, fetched through the pcb23d API (which caches the converted mesh
 * and returns the placement in headers) or, failing that, from EasyEDA directly.
 */
import type { Component } from "../kicad/board";
import { fetchEasyedaModel, lcscFromProperties, LCSC_KEY_PREFIX, type EasyedaModelInfo } from "./easyeda";
import { decodeMesh } from "./mesh-format";
import { DEFAULT_LCSC_API, type ModelFetchOptions } from "./refs";
import type { ModelMesh } from "./vrml";

export interface LcscModel {
  info: EasyedaModelInfo;
  mesh: ModelMesh;
}

/** Components that would render as a box but carry an LCSC number, keyed by C-number. */
export function lcscCandidates(components: Component[], models: Map<string, ModelMesh>): Map<string, Component[]> {
  const out = new Map<string, Component[]>();
  for (const c of components) {
    const has = c.models.some((m) => !m.hide && m.key && models.has(m.key));
    if (has) continue;
    const lcsc = lcscFromProperties(c.properties);
    if (!lcsc) continue;
    const list = out.get(lcsc) ?? [];
    list.push(c);
    out.set(lcsc, list);
  }
  return out;
}

export async function fetchLcscModel(lcsc: string, opts: ModelFetchOptions = {}): Promise<LcscModel | null> {
  const f = opts.fetch ?? fetch;
  const apiBase = opts.lcscApiBase ?? DEFAULT_LCSC_API;
  if (apiBase) {
    try {
      const res = await f(`${apiBase.replace(/\/$/, "")}/${encodeURIComponent(lcsc)}`);
      if (res.ok) {
        const offset = (res.headers.get("x-pcb23d-offset") ?? "0,0,0").split(",").map(Number) as [number, number, number];
        const rotate = (res.headers.get("x-pcb23d-rotate") ?? "0,0,0").split(",").map(Number) as [number, number, number];
        const deltaHeader = res.headers.get("x-pcb23d-delta");
        const delta = (deltaHeader ? deltaHeader.split(",").map(Number) : [offset[0], offset[1]]) as [number, number];
        const padHeader = res.headers.get("x-pcb23d-padsize");
        const padSize = padHeader ? (padHeader.split(",").map(Number) as [number, number]) : undefined;
        const mesh = decodeMesh(new Uint8Array(await res.arrayBuffer()));
        return { info: { lcsc, uuid: res.headers.get("x-pcb23d-uuid") ?? "", title: res.headers.get("x-pcb23d-title") ?? lcsc, offset, rotate, delta, ...(padSize ? { padSize } : {}) }, mesh };
      }
      if (res.status === 404 && res.headers.get("x-pcb23d-model") === "missing") return null;
    } catch {
      // fall through
    }
  }
  try {
    return await fetchEasyedaModel(lcsc, f);
  } catch {
    return null;
  }
}

/**
 * KiCad model offset for an EasyEDA mesh: anchor on this footprint's pad-pattern centre (model
 * axes: x east, y north, so KiCad's y-down local y flips; back-side footprints store mirrored
 * locals, which KiCad's 180° flip undoes) plus EasyEDA's own model-to-pads delta and z.
 */
export function lcscOffset(c: Component, info: EasyedaModelInfo, quarter = 0): [number, number, number] {
  if (!c.padCentre) return info.offset;
  const y = c.side === "front" ? -c.padCentre.y : c.padCentre.y;
  // KiCad rotates by -rz about Z, so an extra +90 turns the model clockwise: (dx, dy) → (dy, -dx)
  let [dx, dy] = info.delta;
  if (quarter === 90) [dx, dy] = [dy, -dx];
  else if (quarter === -90) [dx, dy] = [-dy, dx];
  return [round3(c.padCentre.x + dx), round3(y + dy), info.offset[2]];
}

/**
 * EasyEDA's footprint for a part can be drawn tall where the KiCad footprint is wide (or vice
 * versa). When both pad patterns are clearly elongated and disagree, turn the model 90°.
 */
export function lcscQuarterTurn(c: Component, info: EasyedaModelInfo): 0 | 90 {
  if (!c.padSize || !info.padSize) return 0;
  const [kw, kh] = c.padSize;
  const [ew, eh] = info.padSize;
  if (Math.min(kw, kh) < 1e-6 || Math.min(ew, eh) < 1e-6) return 0;
  const kWide = kw / kh;
  const eWide = ew / eh;
  if ((kWide > 1.5 && eWide < 1 / 1.5) || (kWide < 1 / 1.5 && eWide > 1.5)) return 90;
  return 0;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Attach EasyEDA models to LCSC-tagged components that have none. Adds a synthetic model
 * reference (`lcsc:C123`) to each component and the mesh to `models`.
 */
export async function attachLcscModels(components: Component[], models: Map<string, ModelMesh>, opts: ModelFetchOptions = {}): Promise<number> {
  const candidates = lcscCandidates(components, models);
  if (candidates.size === 0) return 0;
  const entries = [...candidates.entries()];
  let next = 0;
  let attached = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, entries.length)) }, async () => {
    while (next < entries.length) {
      const [lcsc, comps] = entries[next++]!;
      const found = await fetchLcscModel(lcsc, opts);
      done++;
      opts.onProgress?.(done, entries.length, LCSC_KEY_PREFIX + lcsc);
      if (!found) continue;
      const key = LCSC_KEY_PREFIX + lcsc;
      models.set(key, found.mesh);
      for (const c of comps) {
        const quarter = lcscQuarterTurn(c, found.info);
        c.models.push({
          path: key,
          key,
          offset: lcscOffset(c, found.info, quarter),
          scale: [1, 1, 1],
          rotate: [found.info.rotate[0], found.info.rotate[1], found.info.rotate[2] + quarter],
          hide: false,
        });
        attached++;
      }
    }
  });
  await Promise.all(workers);
  return attached;
}

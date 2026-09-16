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
        const mesh = decodeMesh(new Uint8Array(await res.arrayBuffer()));
        return { info: { lcsc, uuid: res.headers.get("x-pcb23d-uuid") ?? "", title: res.headers.get("x-pcb23d-title") ?? lcsc, offset, rotate }, mesh };
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
        c.models.push({ path: key, key, offset: found.info.offset, scale: [1, 1, 1], rotate: found.info.rotate, hide: false });
        attached++;
      }
    }
  });
  await Promise.all(workers);
  return attached;
}

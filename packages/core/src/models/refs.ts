/**
 * Footprint `(model ...)` references and where to get the mesh for them.
 *
 * Library models are named relative to KiCad's packages3D library
 * (`Resistor_SMD.3dshapes/R_0402_1005Metric.wrl`). STEP paths are mapped to the WRL twin,
 * which the library ships for every part. Sources, in order: the pcb23d mesh API (R2 cache,
 * compact binary), then the GitHub mirror of the library (CORS enabled), parsed client-side.
 */
import { decodeMesh } from "./mesh-format";
import { parseVrml, type ModelMesh } from "./vrml";

export interface ModelRef {
  /** Path as written in the board file. */
  path: string;
  /** Library-relative `.wrl` key, or undefined when the path cannot be resolved. */
  key: string | undefined;
  offset: [number, number, number];
  scale: [number, number, number];
  rotate: [number, number, number];
  hide: boolean;
}

export const DEFAULT_MODEL_API = "https://pcbto3d.com/api/models";
export const KICAD_PACKAGES3D_RAW = "https://raw.githubusercontent.com/KiCad/kicad-packages3D/master";

const KEY_RE = /^[\w.+-]+\.3dshapes\/[\w .,+()#&'~-]+\.wrl$/;

/** Normalise a footprint model path to a library key, or undefined when it is project-local. */
export function modelKey(path: string): string | undefined {
  let p = path.trim().replace(/\\/g, "/");
  const m = /\$\{?(KICAD\d*_3DMODEL_DIR|KISYS3DMOD|KICAD_3DMODEL_DIR)\}?\/(.+)$/.exec(p);
  if (m) p = m[2]!;
  else if (/\$\{|\$\(|^[A-Za-z]:|^\/|^\.\.?\//.test(p)) {
    // other variables, absolute, or project-relative: try to salvage a library-style tail
    const tail = /([\w.+-]+\.3dshapes\/[^/]+)$/.exec(p);
    if (!tail) return undefined;
    p = tail[1]!;
  } else {
    const tail = /([\w.+-]+\.3dshapes\/[^/]+)$/.exec(p);
    if (!tail) return undefined;
    p = tail[1]!;
  }
  p = p.replace(/\.(step|stp|wrl|wrz|STEP|STP|WRL)$/, ".wrl");
  if (!/\.wrl$/.test(p)) p += ".wrl";
  return KEY_RE.test(p) ? p : undefined;
}

export function isValidModelKey(key: string): boolean {
  return KEY_RE.test(key) && !key.includes("..");
}

export function modelRawUrl(key: string): string {
  return `${KICAD_PACKAGES3D_RAW}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function modelApiUrl(key: string, apiBase = DEFAULT_MODEL_API): string {
  return `${apiBase.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export type ModelFetcher = (key: string) => Promise<ModelMesh | null>;

export interface ModelFetchOptions {
  fetch?: typeof fetch;
  /** Mesh API base URL; empty string disables the API and goes straight to the library. */
  apiBase?: string;
  /** Max parallel downloads. Default 6. */
  concurrency?: number;
  onProgress?: (done: number, total: number, key: string) => void;
}

/** Fetch + parse one model: API (binary mesh) first, then the library WRL. Null when unavailable. */
export async function fetchModel(key: string, opts: ModelFetchOptions = {}): Promise<ModelMesh | null> {
  if (!isValidModelKey(key)) return null;
  const f = opts.fetch ?? fetch;
  const apiBase = opts.apiBase ?? DEFAULT_MODEL_API;
  if (apiBase) {
    try {
      const res = await f(modelApiUrl(key, apiBase));
      if (res.ok) return decodeMesh(new Uint8Array(await res.arrayBuffer()));
      // the API answers 404 with this header after checking the library itself
      if (res.status === 404 && res.headers.get("x-pcb23d-model") === "missing") return null;
    } catch {
      // fall through to the library
    }
  }
  try {
    const res = await f(modelRawUrl(key));
    if (!res.ok) return null;
    return parseVrml(await res.text());
  } catch {
    return null;
  }
}

/** Fetch many models with bounded concurrency; missing ones are simply absent from the map. */
export async function fetchModels(keys: Iterable<string>, opts: ModelFetchOptions = {}): Promise<Map<string, ModelMesh>> {
  const unique = [...new Set(keys)].filter(isValidModelKey);
  const out = new Map<string, ModelMesh>();
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 6, unique.length)) }, async () => {
    while (next < unique.length) {
      const key = unique[next++]!;
      const mesh = await fetchModel(key, opts);
      if (mesh && mesh.triangles > 0) out.set(key, mesh);
      done++;
      opts.onProgress?.(done, unique.length, key);
    }
  });
  await Promise.all(workers);
  return out;
}

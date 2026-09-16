/**
 * Footprint `(model ...)` references and where to get the mesh for them.
 *
 * Library models are named relative to KiCad's packages3D library
 * (`Resistor_SMD.3dshapes/R_0402_1005Metric.wrl`). STEP paths are mapped to the WRL twin,
 * which the library ships for every part. Sources, in order: the pcb23d mesh API (R2 cache,
 * compact binary), then the GitHub mirror of the library (CORS enabled), parsed client-side.
 */
import { gunzipSync } from "fflate";
import { decodeMesh } from "./mesh-format";
import { isStepPath } from "./occt";
import { parseVrml, type ModelMesh } from "./vrml";

export interface ModelRef {
  /** Path as written in the board file. */
  path: string;
  /**
   * Library key (`X.3dshapes/Y.wrl`), a project key (`project:<path relative to the source>`
   * once `assignProjectModelKeys` ran), or undefined when the path cannot be resolved.
   */
  key: string | undefined;
  /** Path relative to the KiCad project directory for `${KIPRJMOD}` / relative references. */
  projectPath?: string;
  offset: [number, number, number];
  scale: [number, number, number];
  rotate: [number, number, number];
  hide: boolean;
}

export const DEFAULT_MODEL_API = "https://pcbto3d.com/api/models";
export const PROJECT_KEY_PREFIX = "project:";
export const KICAD_PACKAGES3D_RAW = "https://raw.githubusercontent.com/KiCad/kicad-packages3D/master";

const KEY_RE = /^[\w.+-]+\.3dshapes\/[\w .,+()#&'~-]+\.wrl$/;

/** Normalise a footprint model path to a library key, or undefined when it is project-local. */
export function modelKey(path: string): string | undefined {
  let p = path.trim().replace(/\\/g, "/");
  const m = /\$\{?(KICAD\d*_3DMODEL_DIR|KISYS3DMOD|KICAD_3DMODEL_DIR)\}?\/(.+)$/.exec(p);
  if (m) p = m[2]!;
  else if (/^\$\{?KIPRJMOD\}?\//.test(p) || /^\.\.?\//.test(p)) {
    return undefined; // project-local: resolved by assignProjectModelKeys, library only as fallback
  } else if (/\$\{|\$\(|^[A-Za-z]:|^\//.test(p)) {
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

/** `${KIPRJMOD}/models/x.step` → `models/x.step`; plain relative paths pass through. */
export function projectModelPath(path: string): string | undefined {
  const p = path.trim().replace(/\\/g, "/");
  const m = /^\$\{?KIPRJMOD\}?\/(.+)$/.exec(p);
  if (m) return m[1]!;
  if (/^\$\{|^\$\(|^[A-Za-z]:|^\//.test(p)) return undefined; // other variables or absolute
  if (/\.3dshapes\//.test(p) && !p.startsWith(".")) return undefined; // library-style path handled by modelKey
  return p;
}

export function isProjectKey(key: string): boolean {
  return key.startsWith(PROJECT_KEY_PREFIX);
}

/** Join `dir` and a relative `path`, resolving `.` and `..` segments (forward slashes). */
export function joinProjectPath(dir: string, path: string): string {
  const parts: string[] = [];
  for (const seg of `${dir ? dir + "/" : ""}${path}`.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Files next to the board, for project-local models. `paths` use forward slashes. */
export interface ProjectFiles {
  paths: string[];
  read(path: string): Promise<Uint8Array | null>;
}

/** Give project-local model references a `project:` key relative to the board's directory. */
export function assignProjectModelKeys(components: { models: ModelRef[] }[], boardDir: string): void {
  for (const c of components) {
    for (const ref of c.models) {
      if (ref.key) continue;
      const rel = projectModelPath(ref.path);
      if (!rel) continue;
      ref.projectPath = rel;
      ref.key = PROJECT_KEY_PREFIX + joinProjectPath(boardDir, rel);
    }
  }
}

/** Candidate files for a project model path: the WRL/WRZ twin of a STEP, case-insensitively. */
export function projectModelCandidates(path: string, paths: readonly string[], includeStep = false): string[] {
  const stem = path.replace(/\.(step|stp|wrl|wrz|iges|igs)$/i, "");
  const wanted = [`${stem}.wrl`, `${stem}.wrz`, ...(includeStep ? [`${stem}.step`, `${stem}.stp`] : [])];
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p] as const));
  const out: string[] = [];
  for (const w of wanted) {
    const hit = lower.get(w.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Project files whose base name matches `stem` (any 3D extension), shallowest first. */
export function projectFilesByStem(stem: string, paths: readonly string[]): string[] {
  const want = stem.toLowerCase();
  return paths
    .filter((p) => {
      const base = p.slice(p.lastIndexOf("/") + 1).replace(/\.(step|stp|wrl|wrz)$/i, "");
      return base.toLowerCase() === want && /\.(step|stp|wrl|wrz)$/i.test(p);
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

async function readProjectModel(path: string, opts: ModelFetchOptions): Promise<ModelMesh | null> {
  const project = opts.project;
  if (!project) return null;
  const bytes = await project.read(path);
  if (!bytes) return null;
  if (isStepPath(path)) return opts.convertStep ? opts.convertStep(bytes) : null;
  const gz = /\.wrz$/i.test(path) || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  const mesh = parseVrml(new TextDecoder().decode(gz ? gunzipSync(bytes) : bytes));
  return mesh.triangles > 0 ? mesh : null;
}

async function fetchProjectModel(key: string, opts: ModelFetchOptions): Promise<ModelMesh | null> {
  const project = opts.project;
  const path = key.slice(PROJECT_KEY_PREFIX.length);
  for (const candidate of project ? projectModelCandidates(path, project.paths, Boolean(opts.convertStep)) : []) {
    try {
      const mesh = await readProjectModel(candidate, opts);
      if (mesh) return mesh;
    } catch {
      // try the next candidate
    }
  }
  // A vendored copy of a library part (…/X.3dshapes/Y.step) without a WRL: use the library's.
  const tail = /([\w.+-]+\.3dshapes\/[^/]+)$/.exec(path);
  if (tail) {
    const libKey = modelKey(tail[1]!);
    if (libKey) {
      const { project: _unused, ...rest } = opts;
      void _unused;
      return fetchModel(libKey, rest);
    }
  }
  return null;
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
  /** Files of the KiCad project, for `${KIPRJMOD}` and relative model paths. */
  project?: ProjectFiles;
  /**
   * STEP → mesh converter (see `occtStepConverter`). Used for project models that only ship
   * STEP, and for library models missing upstream but vendored in the project. Optional: without
   * it those parts fall back to boxes.
   */
  convertStep?: (bytes: Uint8Array) => Promise<ModelMesh | null>;
  onProgress?: (done: number, total: number, key: string) => void;
}

/** Fetch + parse one model: API (binary mesh) first, then the library WRL. Null when unavailable. */
export async function fetchModel(key: string, opts: ModelFetchOptions = {}): Promise<ModelMesh | null> {
  if (isProjectKey(key)) return fetchProjectModel(key, opts);
  if (!isValidModelKey(key)) return null;
  const mesh = await fetchLibraryModel(key, opts);
  if (mesh) return mesh;
  // Not in the library mirror: maybe the project vendors a copy under the same name.
  if (opts.project) {
    const stem = key.slice(key.lastIndexOf("/") + 1).replace(/\.wrl$/, "");
    for (const candidate of projectFilesByStem(stem, opts.project.paths)) {
      try {
        const m = await readProjectModel(candidate, opts);
        if (m) return m;
      } catch {
        // next
      }
    }
  }
  return null;
}

async function fetchLibraryModel(key: string, opts: ModelFetchOptions): Promise<ModelMesh | null> {
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
  const unique = [...new Set(keys)].filter((k) => isProjectKey(k) || isValidModelKey(k));
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

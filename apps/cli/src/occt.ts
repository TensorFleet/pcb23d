/**
 * STEP conversion for the CLI. Uses occt-import-js (OpenCascade WASM, ~7 MB). When running from
 * source the copy in node_modules is used; the compiled binary downloads the runtime once from
 * pcbto3d.com into the cache directory.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { occtStepConverter, type ModelMesh, type OcctModuleLike } from "pcb23d";

export const OCCT_VERSION = "0.0.23";
const OCCT_FILES = ["occt-import-js.js", "occt-import-js.wasm"];

export function occtCacheDir(): string {
  return process.env.PCB23D_OCCT_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pcb23d", "occt", OCCT_VERSION);
}

async function ensureRuntime(baseUrl: string, log: (msg: string) => void): Promise<string> {
  const local = await findLocalRuntime();
  if (local) return local;
  const dir = occtCacheDir();
  await mkdir(dir, { recursive: true });
  for (const f of OCCT_FILES) {
    const target = join(dir, f);
    if (await Bun.file(target).exists()) continue;
    log(`downloading ${f} for STEP conversion…`);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${f}`);
    if (!res.ok) throw new Error(`could not download ${f} (${res.status})`);
    await Bun.write(target, await res.arrayBuffer());
  }
  return dir;
}

async function findLocalRuntime(): Promise<string | null> {
  try {
    const resolved = Bun.resolveSync("occt-import-js/dist/occt-import-js.js", import.meta.dir);
    if (await Bun.file(resolved).exists()) return dirname(resolved);
  } catch {
    // not installed (compiled binary)
  }
  return null;
}

let loading: Promise<OcctModuleLike | null> | null = null;

/** Lazily load OpenCascade; returns a `convertStep` function or null when unavailable. */
export async function loadStepConverter(
  runtimeUrl: string,
  log: (msg: string) => void,
): Promise<((bytes: Uint8Array) => Promise<ModelMesh | null>) | null> {
  if (!loading) {
    loading = (async () => {
      try {
        const dir = await ensureRuntime(runtimeUrl, log);
        const mod = (await import(join(dir, "occt-import-js.js"))) as { default?: unknown } & Record<string, unknown>;
        const factory = (mod.default ?? mod) as (opts: { locateFile: (f: string) => string }) => Promise<OcctModuleLike>;
        return await factory({ locateFile: (f) => join(dir, f) });
      } catch (error) {
        log(`STEP conversion unavailable: ${(error as Error).message}`);
        return null;
      }
    })();
  }
  const occt = await loading;
  return occt ? occtStepConverter(occt) : null;
}

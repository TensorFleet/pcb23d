#!/usr/bin/env bun
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fetchRemoteBoard, isRemoteInput, parseBackground, renderPcb, type ModelFetchOptions, type ProjectFiles } from "pcb23d";
import { parseArgs, USAGE } from "./args";
import { loadStepConverter } from "./occt";

declare const PCB23D_VERSION: string | undefined;
const VERSION = typeof PCB23D_VERSION === "string" ? PCB23D_VERSION : "0.1.0-dev";

async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`pcb23d: ${(error as Error).message}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  if (opts.inputs.length === 0) {
    console.error(USAGE);
    return 2;
  }
  await mkdir(opts.out, { recursive: true });
  const summaries: unknown[] = [];
  let failures = 0;
  for (const input of opts.inputs) {
    let bytes: Uint8Array;
    let fileName = basename(input);
    let project: ProjectFiles | undefined;
    const started = performance.now();
    try {
      if (isRemoteInput(input)) {
        const remote = await fetchRemoteBoard(input, {
          ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
        });
        bytes = remote.bytes;
        fileName = remote.path; // repo-relative, so ${KIPRJMOD} models resolve
        project = remote.project;
        if (!opts.quiet && !opts.json) console.error(`${input}: fetched ${remote.path}${remote.ref ? ` @${remote.ref}` : ""}`);
      } else {
        const file = Bun.file(input);
        if (!(await file.exists())) throw new Error("no such file");
        bytes = new Uint8Array(await file.arrayBuffer());
        // a bare .kicad_pcb: its project models live next to it on disk
        if (/\.kicad_pcb$/i.test(input) && opts.models) project = await localProject(dirname(resolve(input)));
      }
    } catch (error) {
      failures++;
      console.error(`pcb23d: ${input}: ${(error as Error).message}`);
      summaries.push({ input, error: (error as Error).message });
      continue;
    }
    const stem = basename(fileName).replace(/\.(zip|kicad_pcb)$/i, "") || "board";
    try {
      const result = await renderPcb(bytes, {
        fetchModels: opts.models
          ? {
              ...modelFetchOptions(opts.modelsUrl, opts.quiet || opts.json),
              ...(project ? { project } : {}),
              ...(opts.step ? { convertStep: lazyStepConverter(opts.occtUrl, opts.quiet || opts.json) } : {}),
              ...(opts.lcsc ? {} : { lcscApiBase: "" }),
            }
          : false,
        views: opts.views,
        width: opts.width,
        height: opts.height,
        supersample: opts.supersample,
        background: parseBackground(opts.background),
        components: opts.components,
        fileName,
        ...(opts.maskColor ? { maskColor: opts.maskColor } : {}),
        ...(opts.silkColor ? { silkColor: opts.silkColor } : {}),
        ...(opts.copperFinish ? { copperFinish: opts.copperFinish } : {}),
        ...(opts.pixelsPerMm ? { pixelsPerMm: opts.pixelsPerMm } : {}),
      });
      const files: Record<string, string> = {};
      for (const [name, image] of Object.entries(result.images)) {
        const path = join(opts.out, `${stem}-${name}.png`);
        await Bun.write(path, image.png);
        files[name] = path;
      }
      const ms = Math.round(performance.now() - started);
      if (!opts.quiet && !opts.json) {
        const b = result.board;
        console.error(
          `${input}: ${b.widthMm}×${b.heightMm} mm, ${b.stats.footprints} footprints, ${b.components} bodies (${b.modelsUsed} with 3D models), ${b.stats.tracks} tracks, ${b.stats.vias} vias → ${Object.values(files).join(", ")} (${ms} ms)`,
        );
      }
      summaries.push({ input, board: result.source.path, ...result.board, files, ms });
    } catch (error) {
      failures++;
      console.error(`pcb23d: ${input}: ${(error as Error).message}`);
      summaries.push({ input, error: (error as Error).message });
    }
  }
  if (opts.json) console.log(JSON.stringify(summaries.length === 1 ? summaries[0] : summaries, null, 2));
  return failures > 0 ? 1 : 0;
}

/** Defer loading OpenCascade until the first STEP file actually needs converting. */
function lazyStepConverter(occtUrl: string, quiet: boolean): (bytes: Uint8Array) => Promise<import("pcb23d").ModelMesh | null> {
  const log = quiet ? () => {} : (m: string) => process.stderr.write(`  ${m}\n`);
  return async (bytes) => {
    const convert = await loadStepConverter(occtUrl, log);
    return convert ? convert(bytes) : null;
  };
}

/** Project reader over the directory holding a local .kicad_pcb (for ${KIPRJMOD} models). */
async function localProject(dir: string): Promise<ProjectFiles> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const paths: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath ?? e.path, e.name);
    const rel = relative(dir, full).split("\\").join("/");
    if (rel.startsWith(".git/") || rel.includes("/node_modules/")) continue;
    paths.push(rel);
  }
  return {
    paths,
    read: async (path) => {
      const f = Bun.file(join(dir, path));
      return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
    },
  };
}

/** Model fetching with an on-disk cache of the converted meshes. */
function modelFetchOptions(apiBase: string | undefined, quiet: boolean): ModelFetchOptions {
  const cacheDir = process.env.PCB23D_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pcb23d", "models");
  const realFetch = globalThis.fetch;
  const cachingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isMesh = url.includes("/api/models/");
    const isWrl = url.includes("kicad-packages3D");
    if (!isMesh && !isWrl) return realFetch(input, init);
    const key = decodeURIComponent(url.split(isMesh ? "/api/models/" : "/master/")[1] ?? "");
    const file = join(cacheDir, isMesh ? `${key}.bin` : key);
    const cached = Bun.file(file);
    if (await cached.exists()) return new Response(await cached.arrayBuffer(), { status: 200 });
    const res = await realFetch(input, init);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      await mkdir(dirname(file), { recursive: true });
      await Bun.write(file, buf);
      return new Response(buf, { status: 200, headers: res.headers });
    }
    return res;
  }) as unknown as typeof fetch;
  let lastLine = 0;
  return {
    fetch: cachingFetch,
    ...(apiBase !== undefined ? { apiBase } : {}),
    concurrency: 8,
    onProgress: quiet
      ? undefined
      : (done, total) => {
          const now = Date.now();
          if (done === total || now - lastLine > 500) {
            lastLine = now;
            process.stderr.write(`\r  3D models ${done}/${total}${done === total ? "\n" : ""}`);
          }
        },
  } as ModelFetchOptions;
}

process.exitCode = await main(process.argv.slice(2));

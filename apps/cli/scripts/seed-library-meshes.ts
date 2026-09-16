/**
 * Seed the pcb23d mesh cache from a KiCad installation's 3D model library.
 *
 *   bun apps/cli/scripts/seed-library-meshes.ts <path/to/3dmodels> [--api https://pcbto3d.com/api/models]
 *       [--only Connector_JST.3dshapes] [--concurrency 4] [--dry-run]
 *
 * Every `<Lib>.3dshapes/<Part>.step` is tessellated with OpenCascade (occt-import-js), encoded
 * in pcb23d's mesh format and PUT to /api/models/<Lib>.3dshapes/<Part>.wrl with the admin token
 * (env PCB23D_ADMIN_TOKEN or ~/.config/pcb23d/models-admin-token). Progress is appended to
 * seed-progress.log next to this script so a rerun skips finished keys.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { encodeMesh, meshFromOcct, OCCT_PARAMS } from "pcb23d";
import occtimportjs from "occt-import-js";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (!root) {
  console.error("usage: seed-library-meshes.ts <3dmodels dir> [--api url] [--only Lib.3dshapes] [--concurrency n] [--dry-run]");
  process.exit(2);
}
const rootDir: string = root;
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v ?? fallback;
};
const api = opt("api", "https://pcbto3d.com/api/models").replace(/\/$/, "");
const only = opt("only", "");
const concurrency = Number(opt("concurrency", "4"));
const dryRun = args.includes("--dry-run");
const token = process.env.PCB23D_ADMIN_TOKEN ?? (await readFile(join(homedir(), ".config/pcb23d/models-admin-token"), "utf8").catch(() => "")).trim();
if (!token && !dryRun) {
  console.error("no admin token: set PCB23D_ADMIN_TOKEN or ~/.config/pcb23d/models-admin-token");
  process.exit(2);
}
const progressFile = new URL("./seed-progress.log", import.meta.url).pathname;
const done = new Set((await readFile(progressFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => l.split("\t")[0]!));

const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
const steps = entries
  .filter((e) => e.isFile() && /\.step$/i.test(e.name))
  .map((e) => join((e as { parentPath?: string }).parentPath ?? e.path, e.name))
  .map((full) => relative(rootDir, full).split("\\").join("/"))
  .filter((rel) => /^[^/]+\.3dshapes\/[^/]+\.step$/i.test(rel))
  .filter((rel) => !only || rel.startsWith(only + "/"))
  .sort();
const todo = steps.filter((rel) => !done.has(rel.replace(/\.step$/i, ".wrl")));
console.log(`${steps.length} STEP files, ${todo.length} to do (${done.size} already logged)`);

const occt = await occtimportjs({
  locateFile: (f: string) => Bun.resolveSync(`occt-import-js/dist/${f}`, import.meta.dir),
});

let next = 0;
let ok = 0;
let failed = 0;
let bytesUp = 0;
const t0 = performance.now();
async function worker(): Promise<void> {
  while (next < todo.length) {
    const rel = todo[next++]!;
    const key = rel.replace(/\.step$/i, ".wrl");
    try {
      const bytes = new Uint8Array(await Bun.file(join(rootDir, rel)).arrayBuffer());
      const result = occt.ReadStepFile(bytes, OCCT_PARAMS);
      const mesh = meshFromOcct(result);
      if (!mesh) throw new Error("no triangles");
      const encoded = encodeMesh(mesh);
      if (!dryRun) {
        const res = await fetch(`${api}/${key.split("/").map(encodeURIComponent).join("/")}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-PCB23D-Source": "kicad-3dmodels-seed" },
          body: encoded as unknown as BodyInit,
        });
        if (!res.ok) throw new Error(`PUT ${res.status} ${await res.text()}`);
      }
      ok++;
      bytesUp += encoded.byteLength;
      await appendFile(progressFile, `${key}\t${mesh.triangles}\t${encoded.byteLength}\n`);
    } catch (error) {
      failed++;
      await appendFile(progressFile.replace(/\.log$/, "-failed.log"), `${rel}\t${(error as Error).message}\n`);
    }
    const n = ok + failed;
    if (n % 25 === 0 || n === todo.length) {
      const s = (performance.now() - t0) / 1000;
      console.log(`${n}/${todo.length} ok=${ok} failed=${failed} ${(bytesUp / 1048576).toFixed(1)} MB up, ${s.toFixed(0)}s, ${(n / s).toFixed(2)}/s`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
console.log(`done: ok=${ok} failed=${failed} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);

#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchRemoteBoard, isRemoteInput, parseBackground, renderPcb } from "pcb23d";
import { parseArgs, USAGE } from "./args";

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
    const started = performance.now();
    try {
      if (isRemoteInput(input)) {
        const remote = await fetchRemoteBoard(input, {
          ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
        });
        bytes = remote.bytes;
        fileName = basename(remote.path);
        if (!opts.quiet && !opts.json) console.error(`${input}: fetched ${remote.path}${remote.ref ? ` @${remote.ref}` : ""}`);
      } else {
        const file = Bun.file(input);
        if (!(await file.exists())) throw new Error("no such file");
        bytes = new Uint8Array(await file.arrayBuffer());
      }
    } catch (error) {
      failures++;
      console.error(`pcb23d: ${input}: ${(error as Error).message}`);
      summaries.push({ input, error: (error as Error).message });
      continue;
    }
    const stem = fileName.replace(/\.(zip|kicad_pcb)$/i, "") || "board";
    try {
      const result = await renderPcb(bytes, {
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
          `${input}: ${b.widthMm}×${b.heightMm} mm, ${b.stats.footprints} footprints, ${b.components} bodies, ${b.stats.tracks} tracks, ${b.stats.vias} vias → ${Object.values(files).join(", ")} (${ms} ms)`,
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

process.exitCode = await main(process.argv.slice(2));

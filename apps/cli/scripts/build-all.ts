/** Cross-compile the CLI for every supported platform into apps/cli/dist/. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const pkg = (await Bun.file(join(here, "package.json")).json()) as { version: string };
const version = process.env.PCB23D_VERSION ?? pkg.version;
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

export const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

await mkdir(join(here, "dist"), { recursive: true });
for (const target of TARGETS) {
  const short = target.replace(/^bun-/, "");
  if (only.length && !only.includes(short) && !only.includes(target)) continue;
  const outfile = join(here, "dist", `pcb23d-${short}${target.includes("windows") ? ".exe" : ""}`);
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      join(here, "src/cli.ts"),
      "--compile",
      "--minify",
      `--target=${target}`,
      `--define=PCB23D_VERSION="${version}"`,
      "--outfile",
      outfile,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${target}`);
    process.exit(code);
  }
  console.log(`built ${outfile}`);
}

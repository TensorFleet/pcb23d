import { VIEWS, type ViewName, type ViewSpec } from "pcb23d";

export interface CliOptions {
  inputs: string[];
  out: string;
  views: (ViewName | ({ name: string } & ViewSpec))[];
  width: number;
  height: number;
  supersample: number;
  background: string | undefined;
  maskColor: string | undefined;
  silkColor: string | undefined;
  copperFinish: string | undefined;
  components: boolean;
  models: boolean;
  modelsUrl: string | undefined;
  step: boolean;
  occtUrl: string;
  lcsc: boolean;
  pixelsPerMm: number | undefined;
  json: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export const USAGE = `pcb23d — render KiCad boards to 3D PNG images

Usage:
  pcb23d <board.kicad_pcb | project.zip | github URL | owner/repo> [more inputs...] [options]

Inputs can be local files or GitHub references: https://github.com/owner/repo,
https://github.com/owner/repo/tree/main/hw, owner/repo@ref/path, or a direct link to a
.kicad_pcb / .zip. Set GITHUB_TOKEN to lift the anonymous API rate limit.

Options:
  -o, --out <dir>          Output directory (default: ./pcb23d-out)
  -v, --views <list>       Comma list of views (default: top,bottom,angle)
                           Names: ${Object.keys(VIEWS).join(", ")}
                           Custom: name=azimuth,elevation[,persp|ortho]  e.g. hero=45,30,persp
  -w, --width <px>         Image width (default 1600)
  -h, --height <px>        Image height (default 1200)
  -s, --supersample <n>    Anti-aliasing factor 1-4 (default 2)
      --bg <color>         Background: transparent (default), #rrggbb, or a name
      --mask <color>       Soldermask colour: green, red, blue, black, white, purple, yellow, #hex
      --silk <color>       Silkscreen colour (default from the board, else white)
      --finish <name>      Copper finish: gold (ENIG), silver (HASL), copper
      --no-components      Skip component bodies entirely
      --no-models          Boxes only: do not fetch KiCad library 3D models
      --models-url <base>  Mesh API base (default https://pcbto3d.com/api/models);
                           falls back to raw.githubusercontent.com/KiCad/kicad-packages3D.
                           Converted models are cached in ~/.cache/pcb23d/models
      --no-lcsc            Do not look up EasyEDA models for footprints tagged with an LCSC part
      --no-step            Do not tessellate STEP models (project parts without a WRL).
                           STEP support downloads OpenCascade WASM (7 MB) once into
                           ~/.cache/pcb23d/occt
      --occt-url <base>    Where to fetch that runtime (default https://pcbto3d.com/occt)
      --texture <ppmm>     Texture pixels per mm (default 16)
      --json               Print a JSON summary to stdout
  -q, --quiet              No progress output
      --version            Print version
      --help               Show this help

Output files are named <input-stem>-<view>.png inside the output directory.`;

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    inputs: [],
    out: "pcb23d-out",
    views: ["top", "bottom", "angle"],
    width: 1600,
    height: 1200,
    supersample: 2,
    background: undefined,
    maskColor: undefined,
    silkColor: undefined,
    copperFinish: undefined,
    components: true,
    models: true,
    modelsUrl: undefined,
    step: true,
    occtUrl: "https://pcbto3d.com/occt",
    lcsc: true,
    pixelsPerMm: undefined,
    json: false,
    quiet: false,
    help: false,
    version: false,
  };
  const take = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new Error(`${name} needs a value`);
    return v;
  };
  const int = (v: string, name: string, lo: number, hi: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number from ${lo} to ${hi}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (name: string) => inline ?? (i++, take(i - 1, name));
    switch (key) {
      case "-o":
      case "--out":
        o.out = value(key);
        break;
      case "-v":
      case "--views":
        o.views = parseViews(value(key));
        break;
      case "-w":
      case "--width":
        o.width = int(value(key), key, 8, 8192);
        break;
      case "-h":
      case "--height":
        o.height = int(value(key), key, 8, 8192);
        break;
      case "-s":
      case "--supersample":
        o.supersample = int(value(key), key, 1, 4);
        break;
      case "--bg":
      case "--background":
        o.background = value(key);
        break;
      case "--mask":
        o.maskColor = value(key);
        break;
      case "--silk":
        o.silkColor = value(key);
        break;
      case "--finish":
        o.copperFinish = value(key);
        break;
      case "--texture":
        o.pixelsPerMm = int(value(key), key, 1, 200);
        break;
      case "--no-components":
        o.components = false;
        break;
      case "--no-models":
        o.models = false;
        break;
      case "--models-url":
        o.modelsUrl = value(key);
        break;
      case "--no-step":
        o.step = false;
        break;
      case "--no-lcsc":
        o.lcsc = false;
        break;
      case "--occt-url":
        o.occtUrl = value(key);
        break;
      case "--json":
        o.json = true;
        break;
      case "-q":
      case "--quiet":
        o.quiet = true;
        break;
      case "--help":
        o.help = true;
        break;
      case "--version":
        o.version = true;
        break;
      default:
        if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a}\n\n${USAGE}`);
        o.inputs.push(a);
    }
  }
  return o;
}

export function parseViews(list: string): CliOptions["views"] {
  const out: CliOptions["views"] = [];
  for (const raw of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    // custom: name=az,el[,persp|ortho] — commas inside are split above, so re-join via ':' too
    const custom = /^([a-z0-9_-]+)[=:](-?\d+(?:\.\d+)?)[:/](-?\d+(?:\.\d+)?)(?:[:/](persp|ortho))?$/i.exec(raw);
    if (custom) {
      out.push({
        name: custom[1]!,
        azimuth: Number(custom[2]),
        elevation: Number(custom[3]),
        projection: custom[4]?.toLowerCase() === "ortho" ? "orthographic" : "perspective",
        fov: 28,
      });
      continue;
    }
    if (raw === "all") {
      out.push(...(Object.keys(VIEWS) as ViewName[]));
      continue;
    }
    if (!(raw in VIEWS)) throw new Error(`unknown view "${raw}". Known: ${Object.keys(VIEWS).join(", ")}, all, or name=az/el[/persp|ortho]`);
    out.push(raw as ViewName);
  }
  if (out.length === 0) throw new Error("--views needs at least one view");
  return out;
}

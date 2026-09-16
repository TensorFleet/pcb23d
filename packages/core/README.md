# PCB23D

Turn a KiCad board into 3D renders. Drop a project zip or a `.kicad_pcb` on
[pcbto3d.com](https://pcbto3d.com) and get top, bottom, and angled PNGs. The same
renderer ships as the `pcb23d` npm library and as a single-binary CLI.

Everything is pure TypeScript: an S-expression parser, a 2D layer compositor,
and a software z-buffer rasterizer. No WebGL, no KiCad install, no server.
The web app renders in a Web Worker and never uploads your files.

| Path | What |
| --- | --- |
| `packages/core` | `pcb23d` library: parse `.kicad_pcb`, build textures + mesh, render views, encode PNG |
| `apps/cli` | `pcb23d` command line, compiled with `bun build --compile` for 5 platforms |
| `apps/web` | Astro static site (drag & drop UI), deployed as Cloudflare static assets |

## Quick start

Requirements: Bun 1.4.x.

```bash
bun install
bun test
bun run typecheck
bun run dev                          # web app at http://localhost:4321
bun run render board.zip --out out   # CLI from source
bun run build:cli                    # apps/cli/dist/pcb23d for this machine
bun run build:cli:all                # linux/darwin/windows binaries
```

## CLI

```bash
pcb23d board.zip                              # top, bottom, angle → ./pcb23d-out/
pcb23d https://github.com/owner/repo          # public GitHub repo, tree URL, or owner/repo
pcb23d hat.kicad_pcb --views all --mask black # every preset, black mask
pcb23d *.kicad_pcb -o renders --json          # batch, machine-readable summary
pcb23d hat.kicad_pcb --views hero=45/30/persp --bg "#ffffff" -w 2400 -h 1800
pcb23d board.zip --no-models                  # offline: boxes instead of library models
pcb23d board.zip --no-step                    # skip OpenCascade STEP tessellation
```

3D models are converted meshes cached under `~/.cache/pcb23d/models`; the first render of
a new part fetches it from `pcbto3d.com/api/models` (or GitHub when that is unreachable).

Presets: `top`, `bottom`, `angle`, `angle-bottom`, `front`, `side`. Custom views
are `name=azimuth/elevation[/persp|ortho]`. Colours accept names
(`green`, `black`, `blue`, `red`, `white`, `purple`, `yellow`) or `#rrggbb`. See
`pcb23d --help` for the rest.

Binaries for Linux (x64, arm64), macOS (x64, arm64), and Windows (x64) are on
[GitHub Releases](https://github.com/TensorFleet/pcb23d/releases). They are built
by `.github/workflows/release.yml` when a `v*` tag is pushed.

## Library

```bash
bun add pcb23d     # or npm i pcb23d
```

```ts
import { renderPcb } from "pcb23d";

const bytes = await Bun.file("board.zip").bytes(); // zip, .kicad_pcb bytes, or board text
const result = await renderPcb(bytes, {
  views: ["top", "bottom", "angle", { name: "hero", azimuth: 45, elevation: 30, projection: "perspective" }],
  width: 1600,
  height: 1200,
  maskColor: "black",      // default: the board's stackup colour, then green
  copperFinish: "gold",    // gold | silver | copper
  background: "transparent",
  fetchModels: true,       // KiCad library 3D models; false for boxes only / offline
});

await Bun.write("top.png", result.images.top!.png);
console.log(result.board.stats, result.timings);
```

Lower-level pieces are exported too when you want to render many views from one
scene or draw into your own canvas:

```ts
import { parseBoard, buildScene, renderMesh, encodePng, VIEWS } from "pcb23d";

const board = parseBoard(text);
const scene = buildScene(board, { maskColor: "blue" });
const rgba = renderMesh(scene.mesh, { ...VIEWS.angle, azimuth: 20 }, { width: 800, height: 600 });
ctx.putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0); // browser
const png = encodePng(rgba);
```

The library depends only on `fflate` (zip + deflate) and `earcut` (triangulation)
and runs in Bun, Node 18+, Deno, Cloudflare Workers, and browsers (use a Worker;
a 1600×1200 view takes a few hundred milliseconds).

## What gets rendered

- Board outline from `Edge.Cuts` (lines, arcs, circles, rects, polys; chained with
  0.01 mm tolerance), with cut-outs as holes. Falls back to the content bounds.
- Copper: tracks, arcs, vias, pads (rect, circle, oval, roundrect, chamfered,
  trapezoid, custom primitives), and zone fills. Copper under the mask shows as a
  lighter mask tint; mask openings show the finish colour.
- Soldermask openings including expansion, via tenting (board default and
  per-via overrides), silkscreen graphics and text (KiCad's Newstroke font, with
  justification, mirroring, rotation, italic), and drill holes (round and slots).
- Components from their real KiCad library 3D models: the footprint's
  `(model ...)` reference is mapped to the library's WRL mesh, fetched from
  `pcbto3d.com/api/models` (a Cloudflare Worker that converts the VRML once and
  caches the compact mesh in R2) or straight from the GitHub mirror of
  kicad-packages3D, then placed with KiCad's offset/scale/rotate semantics.
  Footprints without a library model fall back to a box from the `F.Fab` outline
  (or courtyard, or pads) with a height from IPC-7351 names or package families.
  Mounting holes, test points, and fiducials without models are skipped.
- Stackup colours: `(color "Green")` on `F.Mask`/`F.SilkS` and `copper_finish`
  set the defaults.

Project-local models (`${KIPRJMOD}/...` or relative paths) are read from the
zip, the GitHub repo, or the board's directory. WRL/WRZ files are parsed
directly; STEP files are tessellated with OpenCascade (`occt-import-js`, a 7 MB
WASM loaded only when needed: a nested worker in the browser, a cached download
for the CLI). Library parts missing from the mirror but vendored in the project
are picked up by name.

Not rendered yet: inner layers, board edge plating. See [docs/architecture.md](docs/architecture.md). Deployment and domains: [docs/cloudflare.md](docs/cloudflare.md).

## Web app

`apps/web` is a static Astro site. Rendering happens in `src/lib/render.worker.ts`
using the core package directly. `src/worker.ts` is the edge script: host redirects and
the `/api/models/*` mesh cache (R2 bucket `pcb23d-models`). Deploy:

```bash
bun run --cwd apps/web cf:dev             # local wrangler
bun run --cwd apps/web deploy:staging     # pcb23d-staging.workers.dev
bun run --cwd apps/web deploy:production  # pcbto3d.com custom domain (pcb23d.com redirects)
```

## CI

- `ci.yml`: typecheck, tests, library build, web build, CLI compile, and a smoke
  run of the compiled binary on every push and PR. Cross-compiled binaries and
  the web `dist/` are uploaded as artifacts.
- `release.yml`: on `v*` tags, builds all binaries with checksums and creates a
  GitHub release. Set the repository variable `PUBLISH_NPM=true` and the
  `NPM_TOKEN` secret to also publish the library to npm.

## License

MIT

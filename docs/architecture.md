# Architecture

PCB23D renders without KiCad and without a GPU so that one code path serves the browser,
the npm library, and a compiled CLI. The pipeline in `packages/core/src`:

```
zip / .kicad_pcb ──▶ input.ts        pick the board file (prefers the .kicad_pro's sibling)
                 ──▶ sexpr.ts        S-expression tokens → nested arrays
                 ──▶ kicad/board.ts  Board: outline polygons, per-layer filled rings, holes, components
                 ──▶ texture.ts      per side: coverage maps (raster2d.ts) → RGBA texture
                 ──▶ mesh.ts         earcut the outline into a slab; component boxes
                 ──▶ render.ts       camera fit + z-buffer rasterizer + supersampling → RGBA
                 ──▶ png.ts          PNG encode (fflate deflate)
```

## Board model

`parseBoard` walks the top-level items once. Every drawable becomes a filled ring in
`board.shapes[layer]`:

- `segment`/`arc` → stroked polylines with round caps.
- `via` → annulus on the outer copper layers it touches, a plated hole, and a mask
  opening unless tented (board `(tenting front back)` or per-via override).
- `gr_*`/`fp_*` graphics → filled rings and/or stroked outlines. `Edge.Cuts` items are
  kept as open paths and chained into closed rings by `buildOutline`.
- `pad` → copper rings on its copper layers, mask openings on `F.Mask`/`B.Mask`
  expanded by the pad/footprint/board clearance, and a drill hole. Pad `at` is
  footprint-relative; the pad angle in the file is absolute, matching KiCad's writer.
- `zone` → the stored `filled_polygon`s (fractured outlines, no holes needed).
- `footprint`/`module` → a `Component` with a body box derived from Fab, courtyard,
  or pad bounds, and a height from `kicad/heights.ts`.

Coordinates stay in KiCad millimetres (y down) until `mesh.ts` flips y.

## Textures

`raster2d.ts` is a scanline filler with the non-zero winding rule, 4 vertical
sub-samples, and exact horizontal span coverage. Coverage is additive and clamped so
abutting shapes (fractured zone fills, chained tracks) do not leave seams.

`texture.ts` composites per texel: mask over substrate, mask-over-copper tint,
exposed finish through mask openings, silkscreen (clipped by openings), and alpha 0
for holes and outside the outline. Default 16 px/mm, capped at 4096 px.

## 3D models

`models/refs.ts` maps a footprint's `(model "${KICAD9_3DMODEL_DIR}/X.3dshapes/Y.step")` to the
library key `X.3dshapes/Y.wrl`. `models/vrml.ts` parses the library's VRML 2.0 files (Shape,
Appearance/Material with DEF/USE, IndexedFaceSet, Transform/Group; 0.1 inch units → mm) into
colour groups of triangles; `models/mesh-format.ts` is the little-endian binary the cache
stores. `fetchModels` asks `/api/models/<key>` first (Worker: R2 `mesh/v1/<key>.bin`, else
fetch the WRL from the GitHub mirror, convert, store) and falls back to parsing the WRL in the
client. `mesh.ts` places a model with KiCad's order — scale, rotate X/Y/Z (negated), offset,
footprint rotation, 180° about X for back-side parts — or draws the box when no model exists.
`${KIPRJMOD}` and relative model paths get `project:` keys relative to the board's directory
and are read through a `ProjectFiles` reader: the zip contents, `raw.githubusercontent.com`
for GitHub boards, or the local directory in the CLI. A vendored `X.3dshapes/Y.step` without a
WRL falls back to the library's copy.

## Mesh and rendering

The outline (with holes) is triangulated by earcut for the top and bottom faces; every
outline edge becomes a side quad. Components are five-sided boxes. `render.ts` fits a
camera to the mesh bounds (orthographic for top/bottom, 28° perspective for angled
views), then rasterizes with edge functions, perspective-correct UVs, bilinear texture
sampling with an alpha test, flat two-sided lighting, and an `N×N` box-filter
downsample. Output is straight-alpha RGBA.

## Performance

For a 1 MB board (StickHub demo, 94 footprints, 1300 tracks): parse ~30 ms, textures and
mesh ~140 ms, three 1200×900 views at 2× supersampling ~700 ms in Bun. The web app
runs it in a Worker and streams each view as it finishes.

## Known gaps

- Silkscreen and fab text is not drawn (needs a stroke font).
- Project-local models need a WRL/WRZ next to the referenced STEP; STEP itself is not parsed.
- Inner copper layers are parsed but not visible; only outer faces are textured.
- Holes are see-through with no barrel walls.

/**
 * pcb23d — render KiCad boards to 3D PNG images.
 *
 * ```ts
 * import { renderPcb } from "pcb23d";
 * const result = await renderPcb(zipBytes, { views: ["top", "bottom", "angle"] });
 * await Bun.write("top.png", result.images.top!.png);
 * ```
 */
import { buildPalette, type Palette, type RGB, parseColor } from "./color";
import { readBoardSource, type BoardSource } from "./input";
import { parseBoard, type Board, type BoardStats, type Component, type Hole } from "./kicad/board";
import { buildMesh, type Mesh } from "./mesh";
import { encodePng } from "./png";
import { renderMesh, resolveView, VIEWS, type RenderOptions, type RgbaImage, type ViewName, type ViewSpec } from "./render";
import { buildFaceTexture, type Texture, type TextureOptions } from "./texture";

export { parseBoard, buildMesh, renderMesh, encodePng, buildFaceTexture, buildPalette, parseColor, readBoardSource, resolveView, VIEWS };
export { parseSExpr } from "./sexpr";
export { pickBoardPath, isZip } from "./input";
export { kicadKind, pickMainDocument } from "./kicad/files";
export { estimateHeight } from "./kicad/heights";
export type { Board, BoardStats, Component, Hole, Mesh, Palette, RGB, RgbaImage, Texture, TextureOptions, ViewName, ViewSpec, RenderOptions, BoardSource };

export interface SceneOptions extends TextureOptions {
  /** Soldermask colour name or hex. Defaults to the board's stackup colour, then green. */
  maskColor?: string;
  /** Silkscreen colour name or hex. Defaults to the stackup colour, then white. */
  silkColor?: string;
  /** Copper finish: gold/ENIG, silver/HASL, or bare copper. Defaults to the stackup, then gold. */
  copperFinish?: string;
  /** Draw component bodies as boxes. Default true. */
  components?: boolean;
}

export interface Scene {
  board: Board;
  palette: Palette;
  textures: { top: Texture; bottom: Texture };
  mesh: Mesh;
}

/** Parse + texture + mesh once; render many views from it. */
export function buildScene(board: Board, opts: SceneOptions = {}): Scene {
  const palette = buildPalette({
    ...(opts.maskColor || board.stackup.maskColor ? { mask: opts.maskColor ?? board.stackup.maskColor } : {}),
    ...(opts.silkColor || board.stackup.silkColor ? { silk: opts.silkColor ?? board.stackup.silkColor } : {}),
    ...(opts.copperFinish || board.stackup.copperFinish
      ? { finish: opts.copperFinish ?? board.stackup.copperFinish }
      : {}),
  });
  const top = buildFaceTexture(board, "front", palette, opts);
  const bottom = buildFaceTexture(board, "back", palette, opts);
  const mesh = buildMesh(board, top, bottom, palette, { components: opts.components ?? true });
  return { board, palette, textures: { top, bottom }, mesh };
}

export interface RenderPcbOptions extends SceneOptions, RenderOptions {
  /** Which views to render. Default: top, bottom, angle. */
  views?: (ViewName | ({ name: string } & ViewSpec))[];
  /** Skip PNG encoding and return raw RGBA only. */
  png?: boolean;
  /** File name hint for bare (non-zip) inputs. */
  fileName?: string;
}

export interface RenderedView {
  name: string;
  view: ViewSpec;
  width: number;
  height: number;
  rgba: RgbaImage;
  /** PNG bytes (empty when `png: false`). */
  png: Uint8Array;
}

export interface RenderPcbResult {
  source: { path: string; archivePaths: string[] };
  board: {
    title?: string;
    version: number;
    thickness: number;
    widthMm: number;
    heightMm: number;
    layers: string[];
    stats: BoardStats;
    components: number;
    outlineFromEdgeCuts: boolean;
  };
  images: Record<string, RenderedView>;
  timings: { parseMs: number; sceneMs: number; renderMs: number };
}

const DEFAULT_VIEWS: ViewName[] = ["top", "bottom", "angle"];

/**
 * Render a KiCad board (zip archive, `.kicad_pcb` bytes, or board text) to one PNG per view.
 * Synchronous work wrapped in a promise so browser callers can await it uniformly.
 */
export async function renderPcb(input: Uint8Array | string, options: RenderPcbOptions = {}): Promise<RenderPcbResult> {
  return renderPcbSync(input, options);
}

export function renderPcbSync(input: Uint8Array | string, options: RenderPcbOptions = {}): RenderPcbResult {
  const t0 = now();
  const source = readBoardSource(input, options.fileName);
  const board = parseBoard(source.text);
  const t1 = now();
  const scene = buildScene(board, options);
  const t2 = now();
  const images: Record<string, RenderedView> = {};
  const background = options.background ?? "transparent";
  for (const v of options.views ?? DEFAULT_VIEWS) {
    const name = typeof v === "string" ? v : v.name;
    const spec = typeof v === "string" ? VIEWS[v] : v;
    if (!spec) throw new Error(`unknown view "${name}"; known views: ${Object.keys(VIEWS).join(", ")}`);
    const rgba = renderMesh(scene.mesh, spec, {
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.supersample !== undefined ? { supersample: options.supersample } : {}),
      ...(options.light !== undefined ? { light: options.light } : {}),
      background,
    });
    images[name] = {
      name,
      view: spec,
      width: rgba.width,
      height: rgba.height,
      rgba,
      png: options.png === false ? new Uint8Array(0) : encodePng(rgba),
    };
  }
  const t3 = now();
  const b = board.bounds;
  return {
    source: { path: source.path, archivePaths: source.archivePaths },
    board: {
      ...(board.title ? { title: board.title } : {}),
      version: board.version,
      thickness: board.thickness,
      widthMm: round(b.maxX - b.minX),
      heightMm: round(b.maxY - b.minY),
      layers: board.copperLayers,
      stats: board.stats,
      components: board.components.length,
      outlineFromEdgeCuts: board.outlineFromEdgeCuts,
    },
    images,
    timings: { parseMs: round(t1 - t0), sceneMs: round(t2 - t1), renderMs: round(t3 - t2) },
  };
}

/** Parse a background option: "transparent", "#rrggbb", or a colour name. */
export function parseBackground(value: string | undefined): RGB | "transparent" {
  if (!value || value === "transparent" || value === "none") return "transparent";
  return parseColor(value, [255, 255, 255]);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

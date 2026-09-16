/**
 * Composites the copper, soldermask, silkscreen, and drill layers of one board side into an
 * RGBA texture. The alpha channel is 0 outside the outline and inside drill holes.
 */
import type { Palette } from "./color";
import type { Ring } from "./geometry";
import { circle, rect, ringArea, oval } from "./geometry";
import type { Board, Side } from "./kicad/board";
import { createCoverage, fillRings, type CoverageMap, type PixelTransform } from "./raster2d";

export interface Texture {
  width: number;
  height: number;
  /** RGBA, row-major, top row first (KiCad +y is down, so v=0 is the board's minY edge). */
  data: Uint8ClampedArray;
}

export interface TextureOptions {
  /** Texture pixels per board millimetre. Default 16. */
  pixelsPerMm?: number;
  /** Cap on the longest texture edge. Default 4096. */
  maxSize?: number;
  /** Draw copper features (tracks, pads, zones). Default true. */
  copper?: boolean;
  /** Draw silkscreen. Default true. */
  silkscreen?: boolean;
}

export function textureTransform(board: Board, opts: TextureOptions = {}): PixelTransform & { height: number } {
  const b = board.bounds;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  let scale = opts.pixelsPerMm ?? 16;
  const maxSize = opts.maxSize ?? 4096;
  if (Math.max(w, h) * scale > maxSize) scale = maxSize / Math.max(w, h);
  const width = Math.max(2, Math.ceil(w * scale));
  const height = Math.max(2, Math.ceil(h * scale));
  return { scale, originX: b.minX, originY: b.minY, mirrorX: false, width, height };
}

export function buildFaceTexture(board: Board, side: Side, palette: Palette, opts: TextureOptions = {}): Texture {
  const t = textureTransform(board, opts);
  const { width, height } = t;
  const prefix = side === "front" ? "F." : "B.";

  const boardCov = createCoverage(width, height);
  for (const poly of board.outline) {
    const outer = ringArea(poly.outer) < 0 ? [...poly.outer].reverse() : poly.outer;
    const holes = poly.holes.map((h) => (ringArea(h) > 0 ? [...h].reverse() : h));
    fillRings(boardCov, [outer, ...holes], t);
  }

  const layer = (name: string): CoverageMap => {
    const cov = createCoverage(width, height);
    for (const ring of board.shapes.get(name) ?? []) fillRings(cov, [ring], t);
    return cov;
  };
  const drawCopper = opts.copper ?? true;
  const drawSilk = opts.silkscreen ?? true;
  const cu = drawCopper ? layer(`${prefix}Cu`) : createCoverage(width, height);
  const maskOpen = layer(`${prefix}Mask`);
  const silk = drawSilk ? layer(`${prefix}SilkS`) : createCoverage(width, height);

  const holes = createCoverage(width, height);
  const holeRings: Ring[] = [];
  for (const hole of board.holes) {
    if (hole.width <= 0) continue;
    if (Math.abs(hole.width - hole.height) < 1e-6) holeRings.push(circle(hole.center, hole.width / 2));
    else {
      const slot = oval(hole.width, hole.height).map((p) => {
        const a = (hole.rotation * Math.PI) / 180;
        return {
          x: hole.center.x + p.x * Math.cos(a) + p.y * Math.sin(a),
          y: hole.center.y - p.x * Math.sin(a) + p.y * Math.cos(a),
        };
      });
      holeRings.push(slot);
    }
  }
  for (const r of holeRings) fillRings(holes, [r], t);
  // annular ring around plated holes reads as copper even when the pad is tiny
  void rect;

  const data = new Uint8ClampedArray(width * height * 4);
  const { mask, maskOverCopper, substrate, copper, silk: silkRgb } = palette;
  for (let i = 0; i < width * height; i++) {
    const inBoard = boardCov.data[i]!;
    if (inBoard <= 0.001) continue;
    const c = cu.data[i]!;
    const m = maskOpen.data[i]!;
    const s = silk.data[i]! * (1 - m);
    const h = holes.data[i]!;
    // under the mask
    let r = mask[0] + (maskOverCopper[0] - mask[0]) * c;
    let g = mask[1] + (maskOverCopper[1] - mask[1]) * c;
    let b = mask[2] + (maskOverCopper[2] - mask[2]) * c;
    // through mask openings
    const er = substrate[0] + (copper[0] - substrate[0]) * c;
    const eg = substrate[1] + (copper[1] - substrate[1]) * c;
    const eb = substrate[2] + (copper[2] - substrate[2]) * c;
    r += (er - r) * m;
    g += (eg - g) * m;
    b += (eb - b) * m;
    // silkscreen
    r += (silkRgb[0] - r) * s;
    g += (silkRgb[1] - g) * s;
    b += (silkRgb[2] - b) * s;
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255 * inBoard * (1 - h);
  }
  return { width, height, data };
}

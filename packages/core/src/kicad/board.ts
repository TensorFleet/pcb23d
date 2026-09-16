/**
 * Parses a `.kicad_pcb` (KiCad 5 through 9) into a render-oriented board model: the board
 * outline, filled shapes per layer, drill holes, and component boxes. Text is not rendered.
 */
import {
  add,
  arcFromThreePoints,
  arcPoints,
  boundsOf,
  boundsValid,
  circle,
  distance,
  emptyBounds,
  extendBounds,
  legacyArcPoints,
  offsetRing,
  oval,
  pointInRing,
  rect,
  ringArea,
  rotate,
  roundRect,
  strokePolyline,
  strokeSegment,
  type Bounds,
  type Polygon,
  type Ring,
  type Vec2,
} from "../geometry";
import { atoms, child, children, flag, head, isList, num, numbers, parseSExpr, str, type SExpr } from "../sexpr";
import { estimateHeight, isBodilessFootprint } from "./heights";

export type Side = "front" | "back";

export interface Hole {
  center: Vec2;
  /** Slot width along the rotated x axis. Equal to `height` for round holes. */
  width: number;
  height: number;
  rotation: number;
  plated: boolean;
}

export interface Component {
  reference: string;
  value: string;
  footprint: string;
  side: Side;
  /** World-space footprint origin. */
  at: Vec2;
  rotation: number;
  /** Body size in footprint-local millimetres. */
  bodyWidth: number;
  bodyHeight: number;
  /** Body height above the board surface, millimetres. */
  height: number;
  /** World-space body outline (4 corners). */
  outline: Ring;
}

export interface Stackup {
  maskColor?: string;
  silkColor?: string;
  copperFinish?: string;
}

export interface BoardStats {
  footprints: number;
  pads: number;
  tracks: number;
  vias: number;
  zones: number;
  nets: number;
  copperLayers: number;
}

export interface Board {
  version: number;
  generator?: string;
  title?: string;
  /** Total board thickness in mm (defaults to 1.6). */
  thickness: number;
  layerNames: string[];
  copperLayers: string[];
  /** Board shapes from Edge.Cuts. Each has an outer ring and cut-out holes. */
  outline: Polygon[];
  /** Whether `outline` came from Edge.Cuts (false: derived from the content bounds). */
  outlineFromEdgeCuts: boolean;
  bounds: Bounds;
  /** Filled rings per layer name (F.Cu, B.Cu, F.Mask openings, F.SilkS, ...). */
  shapes: Map<string, Ring[]>;
  holes: Hole[];
  components: Component[];
  stackup: Stackup;
  stats: BoardStats;
}

const OUTLINE_TOLERANCE = 0.01;

export function parseBoard(text: string): Board {
  const root = parseSExpr(text).find((x) => head(x) === "kicad_pcb");
  if (!isList(root)) throw new Error("not a KiCad board: missing (kicad_pcb ...)");
  const ctx = new ParseContext(root);
  for (const item of root) {
    if (!isList(item)) continue;
    switch (head(item)) {
      case "segment":
        ctx.stats.tracks++;
        ctx.segment(item);
        break;
      case "arc":
        ctx.stats.tracks++;
        ctx.trackArc(item);
        break;
      case "via":
        ctx.stats.vias++;
        ctx.via(item);
        break;
      case "gr_line":
      case "gr_arc":
      case "gr_circle":
      case "gr_rect":
      case "gr_poly":
      case "gr_curve":
        ctx.graphic(item, IDENTITY);
        break;
      case "footprint":
      case "module":
        ctx.stats.footprints++;
        ctx.footprint(item);
        break;
      case "zone":
        ctx.stats.zones++;
        ctx.zone(item);
        break;
      case "net":
        ctx.stats.nets++;
        break;
      default:
        break;
    }
  }
  return ctx.finish();
}

interface Transform {
  at: Vec2;
  rot: number;
}

const IDENTITY: Transform = { at: { x: 0, y: 0 }, rot: 0 };

function apply(t: Transform, p: Vec2): Vec2 {
  return t.rot === 0 && t.at.x === 0 && t.at.y === 0 ? p : add(rotate(p, t.rot), t.at);
}

class ParseContext {
  readonly shapes = new Map<string, Ring[]>();
  readonly edgePaths: Vec2[][] = [];
  readonly edgeRings: Ring[] = [];
  readonly holes: Hole[] = [];
  readonly components: Component[] = [];
  readonly stats: BoardStats = { footprints: 0, pads: 0, tracks: 0, vias: 0, zones: 0, nets: 0, copperLayers: 0 };
  readonly copperLayers: string[] = [];
  readonly layerNames: string[] = [];
  readonly version: number;
  readonly generator: string | undefined;
  readonly title: string | undefined;
  readonly thickness: number;
  readonly maskMargin: number;
  readonly stackup: Stackup = {};
  readonly tentFront: boolean;
  readonly tentBack: boolean;

  constructor(root: SExpr[]) {
    this.version = num(root, "version", 0);
    this.generator = str(root, "generator");
    const general = child(root, "general");
    this.thickness = num(general, "thickness", 1.6) || 1.6;
    const layers = child(root, "layers");
    if (layers) {
      for (const l of layers) {
        if (!isList(l)) continue;
        const name = l[1];
        if (typeof name !== "string") continue;
        this.layerNames.push(name);
        if (name.endsWith(".Cu")) this.copperLayers.push(name);
      }
    }
    if (this.copperLayers.length === 0) this.copperLayers.push("F.Cu", "B.Cu");
    this.stats.copperLayers = this.copperLayers.length;
    const setup = child(root, "setup");
    this.maskMargin = num(setup, "pad_to_mask_clearance", 0);
    const stackup = child(setup, "stackup");
    if (stackup) {
      for (const l of children(stackup, "layer")) {
        const name = l[1];
        const color = str(l, "color");
        if (!color) continue;
        if (name === "F.Mask") this.stackup.maskColor = color;
        if (name === "F.SilkS") this.stackup.silkColor = color;
      }
      const finish = str(stackup, "copper_finish");
      if (finish) this.stackup.copperFinish = finish;
    }
    const tenting = child(setup, "tenting");
    const tentAtoms = tenting ? atoms(tenting) : [];
    // KiCad tents vias by default; `(tenting front back)` makes that explicit.
    this.tentFront = tenting ? tentAtoms.includes("front") : true;
    this.tentBack = tenting ? tentAtoms.includes("back") : true;
    const titleBlock = child(root, "title_block");
    this.title = str(titleBlock, "title");
  }

  push(layer: string, rings: Ring[]): void {
    if (rings.length === 0) return;
    let list = this.shapes.get(layer);
    if (!list) this.shapes.set(layer, (list = []));
    for (const r of rings) if (r.length >= 3) list.push(r);
  }

  segment(item: SExpr[]): void {
    const layer = str(item, "layer");
    const start = xy(child(item, "start"));
    const end = xy(child(item, "end"));
    const width = num(item, "width", 0);
    if (!layer || !start || !end) return;
    this.push(layer, strokeSegment(start, end, width));
  }

  trackArc(item: SExpr[]): void {
    const layer = str(item, "layer");
    const start = xy(child(item, "start"));
    const mid = xy(child(item, "mid"));
    const end = xy(child(item, "end"));
    const width = num(item, "width", 0);
    if (!layer || !start || !mid || !end) return;
    const arc = arcFromThreePoints(start, mid, end);
    const pts = arc ? arcPoints(arc) : [start, end];
    this.push(layer, strokePolyline(pts, width));
  }

  via(item: SExpr[]): void {
    const at = xy(child(item, "at"));
    if (!at) return;
    const size = num(item, "size", 0.6);
    const drill = num(item, "drill", 0.3);
    const layers = atoms(child(item, "layers"));
    const onFront = layers.includes("F.Cu") || layers.length === 0;
    const onBack = layers.includes("B.Cu") || layers.length === 0;
    const ring = circle(at, size / 2);
    if (onFront) this.push("F.Cu", [ring]);
    if (onBack) this.push("B.Cu", [ring]);
    this.holes.push({ center: at, width: drill, height: drill, rotation: 0, plated: true });
    const tenting = child(item, "tenting");
    const tentF = tentOverride(tenting, "front") ?? this.tentFront;
    const tentB = tentOverride(tenting, "back") ?? this.tentBack;
    const open = circle(at, size / 2 + this.maskMargin);
    if (onFront && !tentF) this.push("F.Mask", [open]);
    if (onBack && !tentB) this.push("B.Mask", [open]);
  }

  /** gr_* / fp_* graphics. Filled shapes go to `shapes`; Edge.Cuts goes to the outline. */
  graphic(item: SExpr[], t: Transform): void {
    const kind = (head(item) ?? "").replace(/^fp_/, "gr_");
    const layer = str(item, "layer");
    if (!layer) return;
    const width = strokeWidth(item);
    const filled = isFilled(item);
    const isEdge = layer === "Edge.Cuts";
    const emit = (points: Vec2[], closed: boolean) => {
      const world = points.map((p) => apply(t, p));
      if (isEdge) {
        if (closed) this.edgeRings.push(world);
        else this.edgePaths.push(world);
        return;
      }
      if (closed && filled) this.push(layer, [world]);
      if (width > 0) {
        const path = closed ? [...world, world[0]!] : world;
        this.push(layer, strokePolyline(path, width));
      }
    };
    switch (kind) {
      case "gr_line": {
        const s = xy(child(item, "start"));
        const e = xy(child(item, "end"));
        if (!s || !e) return;
        emit([s, e], false);
        return;
      }
      case "gr_arc": {
        const s = xy(child(item, "start"));
        const e = xy(child(item, "end"));
        const mid = xy(child(item, "mid"));
        if (!s || !e) return;
        let pts: Vec2[];
        if (mid) {
          const arc = arcFromThreePoints(s, mid, e);
          pts = arc ? arcPoints(arc) : [s, e];
        } else {
          // legacy: start is the centre, end is the arc start, angle is the sweep
          pts = legacyArcPoints(s, e, num(item, "angle", 90));
        }
        emit(pts, false);
        return;
      }
      case "gr_circle": {
        const c = xy(child(item, "center"));
        const e = xy(child(item, "end"));
        if (!c || !e) return;
        const r = distance(c, e);
        if (isEdge) {
          this.edgeRings.push(circle(c, r).map((p) => apply(t, p)));
          return;
        }
        if (filled) {
          this.push(layer, [circle(c, r + width / 2).map((p) => apply(t, p))]);
        } else if (width > 0) {
          const ringPts = circle(c, r);
          this.push(layer, strokePolyline([...ringPts, ringPts[0]!].map((p) => apply(t, p)), width));
        }
        return;
      }
      case "gr_rect": {
        const s = xy(child(item, "start"));
        const e = xy(child(item, "end"));
        if (!s || !e) return;
        emit([s, { x: e.x, y: s.y }, e, { x: s.x, y: e.y }], true);
        return;
      }
      case "gr_poly": {
        const pts = parsePts(child(item, "pts"));
        if (pts.length >= 3) emit(pts, true);
        return;
      }
      case "gr_curve": {
        const pts = parsePts(child(item, "pts"));
        if (pts.length === 4) emit(bezier(pts[0]!, pts[1]!, pts[2]!, pts[3]!), false);
        return;
      }
      default:
        return;
    }
  }

  footprint(item: SExpr[]): void {
    const name = typeof item[1] === "string" ? item[1] : "";
    const atList = child(item, "at");
    const atNums = numbers(atList);
    const t: Transform = { at: { x: atNums[0] ?? 0, y: atNums[1] ?? 0 }, rot: atNums[2] ?? 0 };
    const layer = str(item, "layer") ?? "F.Cu";
    const side: Side = layer.startsWith("B.") ? "back" : "front";
    const fpMaskMargin = numbers(child(item, "solder_mask_margin"))[0];
    const attrs = atoms(child(item, "attr"));
    let reference = "";
    let value = "";
    for (const prop of children(item, "property")) {
      if (prop[1] === "Reference" && typeof prop[2] === "string") reference = prop[2];
      if (prop[1] === "Value" && typeof prop[2] === "string") value = prop[2];
    }
    for (const txt of children(item, "fp_text")) {
      if (txt[1] === "reference" && typeof txt[2] === "string") reference ||= txt[2];
      if (txt[1] === "value" && typeof txt[2] === "string") value ||= txt[2];
    }

    const fabBounds = emptyBounds();
    const crtBounds = emptyBounds();
    const padBounds = emptyBounds();
    let hasBodyPad = false;

    for (const sub of item) {
      if (!isList(sub)) continue;
      const h = head(sub);
      if (h === "pad") {
        this.stats.pads++;
        const info = this.pad(sub, t, fpMaskMargin);
        if (info) {
          if (info.type !== "np_thru_hole") hasBodyPad = true;
          for (const p of info.localRing) extendBounds(padBounds, p);
        }
      } else if (h && (h.startsWith("fp_") || h.startsWith("gr_")) && h !== "fp_text" && h !== "fp_text_box") {
        const subLayer = str(sub, "layer") ?? "";
        this.graphic(sub, t);
        if (subLayer === "F.Fab" || subLayer === "B.Fab") collectLocalBounds(sub, fabBounds);
        else if (subLayer === "F.CrtYd" || subLayer === "B.CrtYd") collectLocalBounds(sub, crtBounds);
      } else if (h === "zone") {
        this.zone(sub);
      }
    }

    if (isBodilessFootprint(name) && !boundsValid(fabBounds)) return;
    if (!hasBodyPad && !boundsValid(fabBounds)) return;
    if (attrs.includes("dnp")) return;

    let body: Bounds | undefined;
    if (boundsValid(fabBounds)) body = fabBounds;
    else if (boundsValid(crtBounds)) body = shrink(crtBounds, 0.25);
    else if (boundsValid(padBounds)) body = padBounds;
    if (!body || !boundsValid(body)) return;

    const bodyWidth = body.maxX - body.minX;
    const bodyHeight = body.maxY - body.minY;
    if (bodyWidth < 0.3 || bodyHeight < 0.3) return;
    const height = estimateHeight(name, bodyWidth, bodyHeight);
    const outline = [
      { x: body.minX, y: body.minY },
      { x: body.maxX, y: body.minY },
      { x: body.maxX, y: body.maxY },
      { x: body.minX, y: body.maxY },
    ].map((p) => apply(t, p));
    this.components.push({
      reference,
      value,
      footprint: name,
      side,
      at: t.at,
      rotation: t.rot,
      bodyWidth,
      bodyHeight,
      height,
      outline,
    });
  }

  pad(item: SExpr[], fp: Transform, fpMaskMargin: number | undefined): { type: string; localRing: Ring } | null {
    const type = typeof item[2] === "string" ? item[2] : "smd";
    const shape = typeof item[3] === "string" ? item[3] : "rect";
    const atNums = numbers(child(item, "at"));
    const local = { x: atNums[0] ?? 0, y: atNums[1] ?? 0 };
    const padRot = atNums[2] ?? 0; // absolute orientation in the file
    const sizeNums = numbers(child(item, "size"));
    const w = sizeNums[0] ?? 0;
    const h = sizeNums[1] ?? w;
    const world = apply(fp, local);
    const layers = expandLayers(atoms(child(item, "layers")), this.copperLayers);
    const drill = child(item, "drill");
    let offset: Vec2 = { x: 0, y: 0 };
    let drillW = 0;
    let drillH = 0;
    if (drill) {
      const off = xy(child(drill, "offset"));
      if (off) offset = off;
      const dn = numbers(drill);
      if (atoms(drill).includes("oval")) {
        drillW = dn[0] ?? 0;
        drillH = dn[1] ?? drillW;
      } else {
        drillW = drillH = dn[0] ?? 0;
      }
    }

    // pad-local shape (unrotated), centred at the shape offset
    let localRings: Ring[] = padShapeRings(item, shape, w, h);
    if (offset.x !== 0 || offset.y !== 0) localRings = localRings.map((r) => r.map((p) => add(p, offset)));
    const place = (r: Ring) => r.map((p) => add(rotate(p, padRot), world));
    const worldRings = localRings.map(place);

    const isCopperPad = type !== "np_thru_hole";
    if (isCopperPad) {
      for (const layer of layers) {
        if (layer.endsWith(".Cu")) this.push(layer, worldRings);
      }
    }
    const margin = numbers(child(item, "solder_mask_margin"))[0] ?? fpMaskMargin ?? this.maskMargin;
    for (const maskLayer of ["F.Mask", "B.Mask"] as const) {
      if (!layers.includes(maskLayer)) continue;
      const rings = margin !== 0 ? localRings.map((r) => offsetRing(r, margin)).map(place) : worldRings;
      this.push(maskLayer, rings);
    }
    if (drillW > 0 && (type === "thru_hole" || type === "np_thru_hole")) {
      this.holes.push({
        center: world,
        width: drillW,
        height: drillH,
        rotation: padRot,
        plated: type === "thru_hole",
      });
    }

    // footprint-local bounds of the pad (rotation relative to the footprint)
    const relRot = padRot - fp.rot;
    const localRing = rect(local, w, h, relRot);
    return { type, localRing };
  }

  zone(item: SExpr[]): void {
    if (child(item, "keepout")) return;
    const zoneLayer = str(item, "layer");
    const zoneLayers = atoms(child(item, "layers"));
    for (const fp of children(item, "filled_polygon")) {
      const layer = str(fp, "layer") ?? zoneLayer ?? zoneLayers[0];
      if (!layer) continue;
      const pts = parsePts(child(fp, "pts"));
      if (pts.length >= 3) this.push(layer, [pts]);
    }
  }

  finish(): Board {
    const outline = buildOutline(this.edgePaths, this.edgeRings);
    let outlineFromEdgeCuts = outline.length > 0;
    let bounds = emptyBounds();
    for (const poly of outline) for (const p of poly.outer) extendBounds(bounds, p);
    let finalOutline = outline;
    if (!boundsValid(bounds)) {
      // no usable Edge.Cuts: use the content bounds with a margin
      bounds = emptyBounds();
      for (const [layer, rings] of this.shapes) {
        if (!layer.endsWith(".Cu") && !layer.endsWith(".SilkS") && !layer.endsWith(".Mask")) continue;
        for (const r of rings) for (const p of r) extendBounds(bounds, p);
      }
      for (const c of this.components) for (const p of c.outline) extendBounds(bounds, p);
      if (!boundsValid(bounds)) bounds = { minX: 0, minY: 0, maxX: 50, maxY: 40 };
      const m = 1;
      bounds = { minX: bounds.minX - m, minY: bounds.minY - m, maxX: bounds.maxX + m, maxY: bounds.maxY + m };
      finalOutline = [
        {
          outer: [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY },
          ],
          holes: [],
        },
      ];
      outlineFromEdgeCuts = false;
    }
    return {
      version: this.version,
      ...(this.generator ? { generator: this.generator } : {}),
      ...(this.title ? { title: this.title } : {}),
      thickness: this.thickness,
      layerNames: this.layerNames,
      copperLayers: this.copperLayers,
      outline: finalOutline,
      outlineFromEdgeCuts,
      bounds,
      shapes: this.shapes,
      holes: this.holes,
      components: this.components,
      stackup: this.stackup,
      stats: this.stats,
    };
  }
}

function tentOverride(tenting: SExpr[] | undefined, side: "front" | "back"): boolean | undefined {
  if (!tenting) return undefined;
  const v = atoms(child(tenting, side))[0];
  if (v === "yes") return true;
  if (v === "no") return false;
  const bare = atoms(tenting);
  if (bare.includes(side)) return true;
  return undefined;
}

function xy(list: SExpr[] | undefined): Vec2 | undefined {
  const n = numbers(list);
  if (n.length < 2) return undefined;
  return { x: n[0]!, y: n[1]! };
}

function strokeWidth(item: SExpr[]): number {
  const stroke = child(item, "stroke");
  if (stroke) return num(stroke, "width", 0);
  return num(item, "width", 0);
}

function isFilled(item: SExpr[]): boolean {
  const fill = child(item, "fill");
  if (!fill) return false;
  const v = atoms(fill)[0];
  if (v === undefined) return true;
  return v === "yes" || v === "solid" || v === "true";
}

/** `(pts (xy ..) (xy ..) (arc (start)(mid)(end)) ...)` → polyline. */
export function parsePts(list: SExpr[] | undefined): Vec2[] {
  const out: Vec2[] = [];
  if (!list) return out;
  for (const c of list) {
    if (!isList(c)) continue;
    const h = head(c);
    if (h === "xy") {
      const p = xy(c);
      if (p) out.push(p);
    } else if (h === "arc") {
      const s = xy(child(c, "start"));
      const m = xy(child(c, "mid"));
      const e = xy(child(c, "end"));
      if (!s || !m || !e) continue;
      const arc = arcFromThreePoints(s, m, e);
      const pts = arc ? arcPoints(arc) : [s, e];
      for (const p of pts) {
        const last = out[out.length - 1];
        if (!last || distance(last, p) > 1e-6) out.push(p);
      }
    }
  }
  return out;
}

function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps = 16): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

function expandLayers(names: string[], copper: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n === "*.Cu") for (const c of copper) out.add(c);
    else if (n === "F&B.Cu") {
      out.add("F.Cu");
      out.add("B.Cu");
    } else if (n.startsWith("*.")) {
      out.add(`F.${n.slice(2)}`);
      out.add(`B.${n.slice(2)}`);
    } else out.add(n);
  }
  return [...out];
}

/** Pad outline in pad-local, unrotated coordinates centred at the origin. */
export function padShapeRings(item: SExpr[], shape: string, w: number, h: number): Ring[] {
  switch (shape) {
    case "circle":
      return [circle({ x: 0, y: 0 }, w / 2)];
    case "oval":
      return [oval(w, h)];
    case "trapezoid": {
      const d = numbers(child(item, "rect_delta"));
      const dx = d[0] ?? 0;
      const dy = d[1] ?? 0;
      const hw = w / 2;
      const hh = h / 2;
      return [
        [
          { x: -hw - dy / 2, y: -hh + dx / 2 },
          { x: hw + dy / 2, y: -hh - dx / 2 },
          { x: hw - dy / 2, y: hh + dx / 2 },
          { x: -hw + dy / 2, y: hh - dx / 2 },
        ],
      ];
    }
    case "roundrect": {
      const ratio = num(item, "roundrect_rratio", 0.25);
      const chamferRatio = num(item, "chamfer_ratio", 0);
      const corners = atoms(child(item, "chamfer"));
      if (chamferRatio > 0 && corners.length > 0) return [chamferedRect(w, h, chamferRatio, corners, ratio)];
      return [roundRect(w, h, ratio * Math.min(w, h))];
    }
    case "custom": {
      const rings: Ring[] = [];
      const options = child(item, "options");
      const anchor = str(options, "anchor") ?? "rect";
      rings.push(anchor === "circle" ? circle({ x: 0, y: 0 }, w / 2) : rect({ x: 0, y: 0 }, w, h));
      const prims = child(item, "primitives");
      if (prims) {
        for (const prim of prims) {
          if (!isList(prim)) continue;
          const pw = strokeWidth(prim);
          const filled = isFilled(prim) || pw === 0;
          switch (head(prim)) {
            case "gr_poly": {
              const pts = parsePts(child(prim, "pts"));
              if (pts.length >= 3) {
                if (filled) rings.push(pts);
                if (pw > 0) rings.push(...strokePolyline([...pts, pts[0]!], pw));
              }
              break;
            }
            case "gr_line": {
              const s = xy(child(prim, "start"));
              const e = xy(child(prim, "end"));
              if (s && e) rings.push(...strokeSegment(s, e, pw));
              break;
            }
            case "gr_circle": {
              const c = xy(child(prim, "center"));
              const e = xy(child(prim, "end"));
              if (c && e) rings.push(circle(c, distance(c, e) + pw / 2));
              break;
            }
            case "gr_rect": {
              const s = xy(child(prim, "start"));
              const e = xy(child(prim, "end"));
              if (s && e) {
                const r = [s, { x: e.x, y: s.y }, e, { x: s.x, y: e.y }];
                if (filled) rings.push(r);
                if (pw > 0) rings.push(...strokePolyline([...r, s], pw));
              }
              break;
            }
            case "gr_arc": {
              const s = xy(child(prim, "start"));
              const m = xy(child(prim, "mid"));
              const e = xy(child(prim, "end"));
              if (s && m && e) {
                const arc = arcFromThreePoints(s, m, e);
                rings.push(...strokePolyline(arc ? arcPoints(arc) : [s, e], pw));
              }
              break;
            }
            default:
              break;
          }
        }
      }
      return rings;
    }
    case "rect":
    default:
      return [rect({ x: 0, y: 0 }, w, h)];
  }
}

function chamferedRect(w: number, h: number, ratio: number, corners: string[], roundRatio: number): Ring {
  const hw = w / 2;
  const hh = h / 2;
  const c = ratio * Math.min(w, h);
  const has = (name: string) => corners.includes(name);
  const ring: Ring = [];
  // top-left (-hw,-hh) going clockwise on screen
  if (has("top_left")) ring.push({ x: -hw + c, y: -hh }, { x: -hw, y: -hh + c });
  else ring.push({ x: -hw, y: -hh });
  if (has("bottom_left")) ring.push({ x: -hw, y: hh - c }, { x: -hw + c, y: hh });
  else ring.push({ x: -hw, y: hh });
  if (has("bottom_right")) ring.push({ x: hw - c, y: hh }, { x: hw, y: hh - c });
  else ring.push({ x: hw, y: hh });
  if (has("top_right")) ring.push({ x: hw, y: -hh + c }, { x: hw - c, y: -hh });
  else ring.push({ x: hw, y: -hh });
  void roundRatio;
  return ring;
}

function collectLocalBounds(item: SExpr[], b: Bounds): void {
  const h = (head(item) ?? "").replace(/^fp_/, "gr_");
  const w = strokeWidth(item) / 2;
  const grow = (p: Vec2, r = 0) => {
    extendBounds(b, { x: p.x - w - r, y: p.y - w - r });
    extendBounds(b, { x: p.x + w + r, y: p.y + w + r });
  };
  if (h === "gr_line" || h === "gr_rect") {
    const s = xy(child(item, "start"));
    const e = xy(child(item, "end"));
    if (s) grow(s);
    if (e) grow(e);
  } else if (h === "gr_arc") {
    const s = xy(child(item, "start"));
    const e = xy(child(item, "end"));
    const m = xy(child(item, "mid"));
    if (s && e && m) {
      const arc = arcFromThreePoints(s, m, e);
      for (const p of arc ? arcPoints(arc) : [s, e]) grow(p);
    } else if (s && e) {
      for (const p of legacyArcPoints(s, e, num(item, "angle", 90))) grow(p);
    }
  } else if (h === "gr_circle") {
    const c = xy(child(item, "center"));
    const e = xy(child(item, "end"));
    if (c && e) grow(c, distance(c, e));
  } else if (h === "gr_poly" || h === "gr_curve") {
    for (const p of parsePts(child(item, "pts"))) grow(p);
  }
}

function shrink(b: Bounds, d: number): Bounds {
  const out = { minX: b.minX + d, minY: b.minY + d, maxX: b.maxX - d, maxY: b.maxY - d };
  return boundsValid(out) ? out : b;
}

/** Chain Edge.Cuts paths into closed rings, then nest holes inside outers. */
export function buildOutline(paths: Vec2[][], rings: Ring[]): Polygon[] {
  const closed: Ring[] = rings.filter((r) => r.length >= 3);
  const open = paths.filter((p) => p.length >= 2).map((p) => [...p]);
  while (open.length > 0) {
    const chain = open.shift()!;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const tail = chain[chain.length - 1]!;
      for (let i = 0; i < open.length; i++) {
        const cand = open[i]!;
        const s = cand[0]!;
        const e = cand[cand.length - 1]!;
        if (distance(tail, s) <= OUTLINE_TOLERANCE) {
          chain.push(...cand.slice(1));
        } else if (distance(tail, e) <= OUTLINE_TOLERANCE) {
          chain.push(...cand.slice(0, -1).reverse());
        } else continue;
        open.splice(i, 1);
        progressed = true;
        break;
      }
      if (distance(chain[0]!, chain[chain.length - 1]!) <= OUTLINE_TOLERANCE) break;
    }
    if (chain.length >= 3) {
      if (distance(chain[0]!, chain[chain.length - 1]!) <= OUTLINE_TOLERANCE) chain.pop();
      const area = Math.abs(ringArea(chain));
      // ignore unclosed scraps unless they span a real area
      if (area > 0.5) closed.push(chain);
    }
  }
  if (closed.length === 0) return [];
  closed.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const polys: Polygon[] = [];
  for (const ring of closed) {
    const sample = ring[0]!;
    const parent = polys.find((p) => pointInRing(sample, p.outer));
    if (parent) parent.holes.push(ring);
    else polys.push({ outer: ring, holes: [] });
  }
  return polys;
}

export { boundsOf, ringArea, flag };

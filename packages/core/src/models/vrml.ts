/**
 * VRML 2.0 reader for KiCad's 3D model library (kicad-packages3D `.wrl`). Handles the subset
 * those files use — Shape / Appearance / Material (DEF & USE), IndexedFaceSet with
 * Coordinate points, Transform and Group nesting — and returns triangles grouped by colour.
 * KiCad VRML models are in 0.1 inch units; output is millimetres.
 */
import type { RGB } from "../color";

export interface MeshGroup {
  color: RGB;
  /** 0..1, 1 = fully transparent. */
  transparency: number;
  /** xyz per vertex, 9 floats per triangle. */
  positions: Float32Array;
}

export interface ModelMesh {
  groups: MeshGroup[];
  triangles: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const WRL_UNIT_MM = 2.54;

type Tok = string;

class Lexer {
  private i = 0;
  private readonly n: number;
  constructor(private readonly s: string) {
    this.n = s.length;
  }
  next(): Tok | null {
    const s = this.s;
    while (this.i < this.n) {
      const c = s.charCodeAt(this.i);
      if (c === 35 /* # */) {
        while (this.i < this.n && s.charCodeAt(this.i) !== 10) this.i++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 /* , */) {
        this.i++;
      } else break;
    }
    if (this.i >= this.n) return null;
    const c = s.charCodeAt(this.i);
    if (c === 123 || c === 125 || c === 91 || c === 93) {
      this.i++;
      return s[this.i - 1]!;
    }
    if (c === 34) {
      let j = this.i + 1;
      while (j < this.n && s.charCodeAt(j) !== 34) j++;
      const out = s.slice(this.i + 1, j);
      this.i = j + 1;
      return out;
    }
    let j = this.i + 1;
    while (j < this.n) {
      const d = s.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 44 || d === 123 || d === 125 || d === 91 || d === 93 || d === 35) break;
      j++;
    }
    const out = s.slice(this.i, j);
    this.i = j;
    return out;
  }
  peek(): Tok | null {
    const save = this.i;
    const t = this.next();
    this.i = save;
    return t;
  }
}

interface Material {
  color: RGB;
  transparency: number;
}

type Mat4 = Float64Array; // column-major 4x4

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Axis-angle rotation (VRML `rotation x y z angle`). */
export function axisAngle(x: number, y: number, z: number, angle: number): Mat4 {
  const l = Math.hypot(x, y, z);
  if (l < 1e-12 || angle === 0) return identity();
  x /= l;
  y /= l;
  z /= l;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const m = identity();
  m[0] = t * x * x + c;
  m[1] = t * x * y + s * z;
  m[2] = t * x * z - s * y;
  m[4] = t * x * y - s * z;
  m[5] = t * y * y + c;
  m[6] = t * y * z + s * x;
  m[8] = t * x * z + s * y;
  m[9] = t * y * z - s * x;
  m[10] = t * z * z + c;
  return m;
}

function apply(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

const DEFAULT_MATERIAL: Material = { color: [0.6 * 255, 0.6 * 255, 0.6 * 255], transparency: 0 };

class Parser {
  readonly lex: Lexer;
  readonly defs = new Map<string, Material>();
  readonly groups = new Map<string, { mat: Material; tris: number[] }>();
  triangles = 0;

  constructor(text: string) {
    this.lex = new Lexer(text);
  }

  parse(): ModelMesh {
    const root = identity();
    let tok: Tok | null;
    while ((tok = this.lex.next()) !== null) this.node(tok, root);
    const groups: MeshGroup[] = [];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const g of this.groups.values()) {
      if (g.tris.length === 0) continue;
      const positions = new Float32Array(g.tris);
      for (let i = 0; i < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const v = positions[i + k]!;
          if (v < min[k]!) min[k] = v;
          if (v > max[k]!) max[k] = v;
        }
      groups.push({ color: g.mat.color, transparency: g.mat.transparency, positions });
    }
    return { groups, triangles: this.triangles, bounds: { min, max } };
  }

  /** Parse one node whose first token is `tok`, in transform `m`. */
  private node(tok: Tok, m: Mat4, currentMat: Material = DEFAULT_MATERIAL): void {
    if (tok === "DEF") {
      const name = this.lex.next();
      const type = this.lex.next();
      if (type === "Material" && name) {
        const mat = this.material();
        this.defs.set(name, mat);
        this.pendingMaterial = mat;
        return;
      }
      if (type) this.node(type, m, currentMat);
      return;
    }
    if (tok === "USE") {
      const name = this.lex.next();
      if (name && this.defs.has(name)) this.pendingMaterial = this.defs.get(name)!;
      return;
    }
    switch (tok) {
      case "Transform":
        this.transform(m, currentMat);
        return;
      case "Group":
      case "Collision":
      case "Switch":
      case "Anchor":
      case "Billboard":
        this.group(m, currentMat);
        return;
      case "Shape":
        this.shape(m, currentMat);
        return;
      case "Material":
        this.pendingMaterial = this.material();
        return;
      case "{":
      case "[":
        this.skipBlock(tok);
        return;
      default:
        // field name or unknown node: if followed by a block, skip it
        if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
        return;
    }
  }

  private pendingMaterial: Material | null = null;

  private expect(t: Tok): void {
    const got = this.lex.next();
    if (got !== t) throw new Error(`VRML: expected ${t} got ${got}`);
  }

  private skipBlock(open: Tok): void {
    const close = open === "{" ? "}" : "]";
    let depth = 1;
    let t: Tok | null;
    while ((t = this.lex.next()) !== null) {
      if (t === "{" || t === "[") depth++;
      else if (t === "}" || t === "]") {
        depth--;
        if (depth === 0 && t === close) return;
        if (depth === 0) return;
      }
    }
  }

  private numbers(): number[] {
    // reads `[ n n n ... ]` or a single bare number sequence
    const out: number[] = [];
    let t = this.lex.next();
    if (t === "[") {
      while ((t = this.lex.next()) !== null && t !== "]") {
        const v = Number(t);
        if (!Number.isNaN(v)) out.push(v);
      }
      return out;
    }
    if (t !== null) {
      const v = Number(t);
      if (!Number.isNaN(v)) out.push(v);
    }
    return out;
  }

  private transform(parent: Mat4, mat: Material): void {
    this.expect("{");
    let m = parent;
    let translate: number[] = [0, 0, 0];
    let rot: number[] = [0, 0, 1, 0];
    let sc: number[] = [1, 1, 1];
    let center: number[] = [0, 0, 0];
    let scaleOrientation: number[] = [0, 0, 1, 0];
    const children: (() => void)[] = [];
    let t: Tok | null;
    // VRML allows children before the transform fields, so buffer children and run them after.
    while ((t = this.lex.next()) !== null && t !== "}") {
      switch (t) {
        case "translation":
          translate = this.readFloats(3);
          break;
        case "rotation":
          rot = this.readFloats(4);
          break;
        case "scale":
          sc = this.readFloats(3);
          break;
        case "center":
          center = this.readFloats(3);
          break;
        case "scaleOrientation":
          scaleOrientation = this.readFloats(4);
          break;
        case "bboxCenter":
        case "bboxSize":
          this.readFloats(3);
          break;
        case "children": {
          const save = this.captureBlock();
          children.push(() => this.replay(save, () => m, mat));
          break;
        }
        default:
          if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
      }
    }
    const [tx, ty, tz] = translate as [number, number, number];
    const [cx, cy, cz] = center as [number, number, number];
    const so = scaleOrientation as [number, number, number, number];
    const local = multiply(
      multiply(
        multiply(multiply(translation(tx, ty, tz), translation(cx, cy, cz)), axisAngle(rot[0]!, rot[1]!, rot[2]!, rot[3]!)),
        multiply(multiply(axisAngle(so[0], so[1], so[2], so[3]), scaling(sc[0]!, sc[1]!, sc[2]!)), axisAngle(so[0], so[1], so[2], -so[3])),
      ),
      translation(-cx, -cy, -cz),
    );
    m = multiply(parent, local);
    for (const run of children) run();
  }

  private readFloats(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.lex.next();
      if (t === null) break;
      out.push(Number(t));
    }
    return out;
  }

  /** Capture the raw token range of a `[ ... ]` / `{ ... }` block for deferred parsing. */
  private captureBlock(): Tok[] {
    const toks: Tok[] = [];
    const open = this.lex.next();
    if (open !== "[" && open !== "{") {
      if (open !== null) toks.push(open);
      return toks;
    }
    let depth = 1;
    let t: Tok | null;
    while ((t = this.lex.next()) !== null) {
      if (t === "{" || t === "[") depth++;
      else if (t === "}" || t === "]") {
        depth--;
        if (depth === 0) break;
      }
      toks.push(t);
    }
    return toks;
  }

  private replay(toks: Tok[], m: () => Mat4, mat: Material): void {
    const saved = this.lex;
    (this as { lex: Lexer }).lex = new Lexer(toks.map(quoteIfNeeded).join(" "));
    let t: Tok | null;
    while ((t = this.lex.next()) !== null) this.node(t, m(), mat);
    (this as { lex: Lexer }).lex = saved;
  }

  private group(m: Mat4, mat: Material): void {
    this.expect("{");
    let t: Tok | null;
    while ((t = this.lex.next()) !== null && t !== "}") {
      if (t === "children") {
        const toks = this.captureBlock();
        this.replay(toks, () => m, mat);
      } else if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
      else this.node(t, m, mat);
    }
  }

  private material(): Material {
    this.expect("{");
    let color: RGB = [0.8 * 255, 0.8 * 255, 0.8 * 255];
    let transparency = 0;
    let t: Tok | null;
    while ((t = this.lex.next()) !== null && t !== "}") {
      if (t === "diffuseColor") {
        const [r, g, b] = this.readFloats(3);
        color = [(r ?? 0.8) * 255, (g ?? 0.8) * 255, (b ?? 0.8) * 255];
      } else if (t === "transparency") transparency = this.readFloats(1)[0] ?? 0;
      else if (t === "ambientIntensity" || t === "shininess") this.readFloats(1);
      else if (t === "specularColor" || t === "emissiveColor") this.readFloats(3);
      else if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
    }
    return { color, transparency };
  }

  private shape(m: Mat4, inherited: Material): void {
    this.expect("{");
    let mat = inherited;
    let points: number[] | null = null;
    let index: number[] | null = null;
    let t: Tok | null;
    while ((t = this.lex.next()) !== null && t !== "}") {
      if (t === "appearance") {
        this.pendingMaterial = null;
        const type = this.lex.next(); // Appearance or DEF/USE
        if (type === "DEF") {
          this.lex.next();
          this.lex.next();
          this.appearance();
        } else if (type === "USE") {
          this.lex.next();
        } else this.appearance();
        if (this.pendingMaterial) mat = this.pendingMaterial;
      } else if (t === "geometry") {
        let type = this.lex.next();
        if (type === "DEF") {
          this.lex.next();
          type = this.lex.next();
        }
        if (type === "IndexedFaceSet") {
          const g = this.indexedFaceSet();
          points = g.points;
          index = g.index;
        } else if (type === "USE") this.lex.next();
        else if (this.lex.peek() === "{") this.skipBlock(this.lex.next()!);
      } else if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
    }
    if (!points || !index) return;
    const key = `${mat.color.map((c) => Math.round(c)).join(",")}|${mat.transparency}`;
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, (group = { mat, tris: [] }));
    const tris = group.tris;
    const world: number[] = new Array(points.length);
    for (let i = 0; i + 2 < points.length; i += 3) {
      const [x, y, z] = apply(m, points[i]!, points[i + 1]!, points[i + 2]!);
      world[i] = x * WRL_UNIT_MM;
      world[i + 1] = y * WRL_UNIT_MM;
      world[i + 2] = z * WRL_UNIT_MM;
    }
    const nPts = points.length / 3;
    let face: number[] = [];
    const flush = () => {
      for (let k = 1; k + 1 < face.length; k++) {
        const a = face[0]!;
        const b = face[k]!;
        const c = face[k + 1]!;
        if (a >= nPts || b >= nPts || c >= nPts) continue;
        tris.push(world[a * 3]!, world[a * 3 + 1]!, world[a * 3 + 2]!);
        tris.push(world[b * 3]!, world[b * 3 + 1]!, world[b * 3 + 2]!);
        tris.push(world[c * 3]!, world[c * 3 + 1]!, world[c * 3 + 2]!);
        this.triangles++;
      }
      face = [];
    };
    for (const idx of index) {
      if (idx < 0) flush();
      else face.push(idx);
    }
    flush();
  }

  private appearance(): void {
    this.expect("{");
    let t: Tok | null;
    while ((t = this.lex.next()) !== null && t !== "}") {
      if (t === "material") {
        const type = this.lex.next();
        if (type === "DEF") {
          const name = this.lex.next();
          this.lex.next(); // Material
          const mat = this.material();
          if (name) this.defs.set(name, mat);
          this.pendingMaterial = mat;
        } else if (type === "USE") {
          const name = this.lex.next();
          if (name && this.defs.has(name)) this.pendingMaterial = this.defs.get(name)!;
        } else if (type === "Material") this.pendingMaterial = this.material();
        else if (this.lex.peek() === "{") this.skipBlock(this.lex.next()!);
      } else if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
    }
  }

  private indexedFaceSet(): { points: number[]; index: number[] } {
    this.expect("{");
    let points: number[] = [];
    let index: number[] = [];
    let t: Tok | null;
    while ((t = this.lex.next()) !== null && t !== "}") {
      if (t === "coord") {
        let type = this.lex.next();
        if (type === "DEF") {
          this.lex.next();
          type = this.lex.next();
        }
        if (type === "Coordinate") {
          this.expect("{");
          let u: Tok | null;
          while ((u = this.lex.next()) !== null && u !== "}") {
            if (u === "point") points = this.numbers();
            else if (this.lex.peek() === "[" || this.lex.peek() === "{") this.skipBlock(this.lex.next()!);
          }
        } else if (type === "USE") this.lex.next();
      } else if (t === "coordIndex") index = this.numbers();
      else if (t === "creaseAngle" || t === "solid" || t === "ccw" || t === "convex" || t === "normalPerVertex" || t === "colorPerVertex") this.lex.next();
      else if (this.lex.peek() === "{" || this.lex.peek() === "[") this.skipBlock(this.lex.next()!);
      else if (t === "normal" || t === "color" || t === "texCoord") {
        const type = this.lex.next();
        if (type === "USE") this.lex.next();
        else if (this.lex.peek() === "{") this.skipBlock(this.lex.next()!);
      }
    }
    return { points, index };
  }
}

function quoteIfNeeded(t: Tok): string {
  return /[\s{}[\],#]/.test(t) || t === "" ? `"${t}"` : t;
}

export function parseVrml(text: string): ModelMesh {
  if (!/^#VRML\s+V2\.0/i.test(text.trimStart())) {
    if (/^#VRML\s+V1\.0/i.test(text.trimStart())) throw new Error("VRML 1.0 models are not supported");
  }
  return new Parser(text).parse();
}

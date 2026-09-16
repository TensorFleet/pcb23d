/**
 * Software rasterizer: perspective or orthographic camera, z-buffer, flat shading,
 * perspective-correct bilinear texture sampling with alpha test, and box-filter supersampling.
 * No WebGL, so it runs identically in Bun, Node, Workers, and the browser.
 */
import type { RGB } from "./color";
import type { Mesh } from "./mesh";
import type { Texture } from "./texture";

export type Vec3 = [number, number, number];

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, straight (non-premultiplied) alpha. */
  data: Uint8ClampedArray;
}

export interface ViewSpec {
  /** Degrees around the board's vertical axis. 0 looks from the front (south edge). */
  azimuth: number;
  /** Degrees above the board plane. 90 is straight down, -90 straight up from below. */
  elevation: number;
  projection: "perspective" | "orthographic";
  /** Vertical field of view in degrees (perspective only). */
  fov?: number;
  /** Extra room around the board as a fraction of the frame. Default 0.06. */
  margin?: number;
}

export type ViewName = "top" | "bottom" | "angle" | "angle-bottom" | "front" | "side";

export const VIEWS: Record<ViewName, ViewSpec> = {
  top: { azimuth: 0, elevation: 90, projection: "orthographic" },
  bottom: { azimuth: 0, elevation: -90, projection: "orthographic" },
  angle: { azimuth: -32, elevation: 38, projection: "perspective", fov: 28 },
  "angle-bottom": { azimuth: -32, elevation: -38, projection: "perspective", fov: 28 },
  front: { azimuth: 0, elevation: 12, projection: "perspective", fov: 28 },
  side: { azimuth: 90, elevation: 12, projection: "perspective", fov: 28 },
};

export function resolveView(view: ViewName | ViewSpec): ViewSpec {
  return typeof view === "string" ? VIEWS[view] : view;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Supersampling factor per axis (1..4). Default 2. */
  supersample?: number;
  /** Background colour or "transparent". Default transparent. */
  background?: RGB | "transparent";
  /** Direction the key light comes from, world space. */
  light?: Vec3;
}

interface Camera {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  ortho: boolean;
  /** tan(fov/2) for perspective; half-height in world units for orthographic. */
  scale: number;
  aspect: number;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function makeCamera(mesh: Mesh, view: ViewSpec, aspect: number): Camera {
  const { min, max } = mesh.bounds;
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const az = (view.azimuth * Math.PI) / 180;
  const el = (view.elevation * Math.PI) / 180;
  // azimuth 0 => camera on the -y (front) side looking toward +y
  const dir: Vec3 = normalize([Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)]);
  const straight = Math.abs(view.elevation) > 89.5;
  const worldUp: Vec3 = straight ? [Math.sin(az) * 0 + 0, 1, 0] : [0, 0, 1];
  const forward = normalize([-dir[0], -dir[1], -dir[2]]);
  let right = normalize(cross(forward, worldUp));
  if (straight) right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const ortho = view.projection === "orthographic";
  const margin = 1 + (view.margin ?? 0.06) * 2;
  const fov = ((view.fov ?? 28) * Math.PI) / 180;
  const tanHalf = Math.tan(fov / 2);

  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);

  let distance = 0;
  let halfHeight = 0;
  if (ortho) {
    for (const c of corners) {
      const rel = sub(c, target);
      halfHeight = Math.max(halfHeight, Math.abs(dot(rel, up)), Math.abs(dot(rel, right)) / aspect);
    }
    halfHeight *= margin;
    distance = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 2 + 10;
  } else {
    for (const c of corners) {
      const rel = sub(c, target);
      const depth = dot(rel, dir); // toward the camera
      const y = Math.abs(dot(rel, up)) * margin;
      const x = (Math.abs(dot(rel, right)) * margin) / aspect;
      distance = Math.max(distance, depth + y / tanHalf, depth + x / tanHalf);
    }
  }
  const eye: Vec3 = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];
  return { eye, right, up, forward, ortho, scale: ortho ? halfHeight : tanHalf, aspect };
}

export function renderMesh(mesh: Mesh, view: ViewName | ViewSpec, opts: RenderOptions = {}): RgbaImage {
  const outW = Math.max(8, Math.round(opts.width ?? 1200));
  const outH = Math.max(8, Math.round(opts.height ?? 900));
  const ss = Math.max(1, Math.min(4, Math.round(opts.supersample ?? 2)));
  const W = outW * ss;
  const H = outH * ss;
  const spec = resolveView(view);
  const cam = makeCamera(mesh, spec, outW / outH);
  const light = normalize(opts.light ?? [-0.45, -0.35, 1]);

  const color = new Float32Array(W * H * 4);
  const depth = new Float32Array(W * H).fill(-Infinity);
  if (opts.background && opts.background !== "transparent") {
    const [r, g, b] = opts.background;
    for (let i = 0; i < W * H; i++) {
      color[i * 4] = r;
      color[i * 4 + 1] = g;
      color[i * 4 + 2] = b;
      color[i * 4 + 3] = 255;
    }
  }

  const { tris, material, materials, count } = mesh;
  // projected vertex scratch
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  const zi = [0, 0, 0]; // inverse depth for z-test
  const pc = [0, 0, 0]; // perspective-correct weight (1/w or 1)
  const halfW = W / 2;
  const halfH = H / 2;

  for (let ti = 0; ti < count; ti++) {
    const o = ti * 15;
    let skip = false;
    for (let v = 0; v < 3; v++) {
      const px = tris[o + v * 3]! - cam.eye[0];
      const py = tris[o + v * 3 + 1]! - cam.eye[1];
      const pz = tris[o + v * 3 + 2]! - cam.eye[2];
      const cx = px * cam.right[0] + py * cam.right[1] + pz * cam.right[2];
      const cy = px * cam.up[0] + py * cam.up[1] + pz * cam.up[2];
      const cz = px * cam.forward[0] + py * cam.forward[1] + pz * cam.forward[2];
      if (cam.ortho) {
        sx[v] = (cx / (cam.scale * cam.aspect)) * halfW + halfW;
        sy[v] = halfH - (cy / cam.scale) * halfH;
        zi[v] = -cz;
        pc[v] = 1;
      } else {
        if (cz <= 1e-3) {
          skip = true;
          break;
        }
        sx[v] = (cx / (cz * cam.scale * cam.aspect)) * halfW + halfW;
        sy[v] = halfH - (cy / (cz * cam.scale)) * halfH;
        zi[v] = 1 / cz;
        pc[v] = 1 / cz;
      }
    }
    if (skip) continue;

    // flat normal & shade
    const ax = tris[o]!, ay = tris[o + 1]!, az = tris[o + 2]!;
    const e1: Vec3 = [tris[o + 3]! - ax, tris[o + 4]! - ay, tris[o + 5]! - az];
    const e2: Vec3 = [tris[o + 6]! - ax, tris[o + 7]! - ay, tris[o + 8]! - az];
    const n = normalize(cross(e1, e2));
    const ndl = Math.abs(dot(n, light));
    const shade = 0.58 + 0.42 * ndl;

    const mat = materials[material[ti]!]!;
    const tex = mat.kind === "texture" ? mat.texture : null;
    const flat = mat.kind === "color" ? mat.rgb : null;

    const minX = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
    const minY = Math.max(0, Math.floor(Math.min(sy[0]!, sy[1]!, sy[2]!)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy[0]!, sy[1]!, sy[2]!)));
    if (minX > maxX || minY > maxY) continue;

    const x0 = sx[0]!, y0 = sy[0]!, x1 = sx[1]!, y1 = sy[1]!, x2 = sx[2]!, y2 = sy[2]!;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const invArea = 1 / area;

    const u0 = tris[o + 9]! * pc[0]!, v0 = tris[o + 10]! * pc[0]!;
    const u1 = tris[o + 11]! * pc[1]!, v1 = tris[o + 12]! * pc[1]!;
    const u2 = tris[o + 13]! * pc[2]!, v2 = tris[o + 14]! * pc[2]!;

    for (let py = minY; py <= maxY; py++) {
      const yc = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xc = px + 0.5;
        let w0 = ((x1 - xc) * (y2 - yc) - (x2 - xc) * (y1 - yc)) * invArea;
        let w1 = ((x2 - xc) * (y0 - yc) - (x0 - xc) * (y2 - yc)) * invArea;
        let w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        if (w0 < 0) w0 = 0;
        if (w1 < 0) w1 = 0;
        if (w2 < 0) w2 = 0;
        const z = w0 * zi[0]! + w1 * zi[1]! + w2 * zi[2]!;
        const di = py * W + px;
        if (z <= depth[di]!) continue;
        let r: number, g: number, b: number;
        if (tex) {
          const q = w0 * pc[0]! + w1 * pc[1]! + w2 * pc[2]!;
          const u = (w0 * u0 + w1 * u1 + w2 * u2) / q;
          const v = (w0 * v0 + w1 * v1 + w2 * v2) / q;
          const s = sampleBilinear(tex, u, v);
          if (s[3] < 0.5) continue;
          r = s[0];
          g = s[1];
          b = s[2];
        } else {
          r = flat![0];
          g = flat![1];
          b = flat![2];
        }
        depth[di] = z;
        const ci = di * 4;
        color[ci] = r * shade;
        color[ci + 1] = g * shade;
        color[ci + 2] = b * shade;
        color[ci + 3] = 255;
      }
    }
  }

  return downsample(color, W, H, ss);
}

const sample: [number, number, number, number] = [0, 0, 0, 0];

function sampleBilinear(tex: Texture, u: number, v: number): [number, number, number, number] {
  const fx = Math.min(Math.max(u, 0), 1) * (tex.width - 1);
  const fy = Math.min(Math.max(v, 0), 1) * (tex.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, tex.width - 1);
  const y1 = Math.min(y0 + 1, tex.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = tex.data;
  const i00 = (y0 * tex.width + x0) * 4;
  const i10 = (y0 * tex.width + x1) * 4;
  const i01 = (y1 * tex.width + x0) * 4;
  const i11 = (y1 * tex.width + x1) * 4;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let c = 0; c < 4; c++) {
    sample[c] = d[i00 + c]! * w00 + d[i10 + c]! * w10 + d[i01 + c]! * w01 + d[i11 + c]! * w11;
  }
  sample[3] /= 255;
  return sample;
}

function downsample(color: Float32Array, W: number, H: number, ss: number): RgbaImage {
  const outW = W / ss;
  const outH = H / ss;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        let i = ((y * ss + dy) * W + x * ss) * 4;
        for (let dx = 0; dx < ss; dx++, i += 4) {
          const alpha = color[i + 3]! / 255;
          r += color[i]! * alpha;
          g += color[i + 1]! * alpha;
          b += color[i + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (y * outW + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a * inv * 255;
      }
    }
  }
  return { width: outW, height: outH, data: out };
}

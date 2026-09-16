/**
 * Edge script in front of the static site.
 *  - Host canonicalisation: with PRIMARY_HOST set, other hosts 301 to it (production).
 *  - /api/models/<library key>: KiCad 3D models converted to pcb23d's binary mesh format,
 *    cached in R2 (bucket MODELS) and the edge cache. Source is the GitHub mirror of
 *    kicad-packages3D. Anything else is served from the static assets.
 */
import { encodeMesh, isValidModelKey, modelRawUrl, parseVrml } from "pcb23d";

/** Minimal Workers runtime typings so this file compiles alongside the DOM-typed site. */
interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MODELS?: R2BucketLike;
  PRIMARY_HOST?: string;
}

const MESH_VERSION = "v1";
const MAX_WRL_BYTES = 40 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const primary = env.PRIMARY_HOST;
    if (primary) {
      const host = url.hostname;
      const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".workers.dev");
      if (host !== primary && !local) {
        url.hostname = primary;
        url.protocol = "https:";
        url.port = "";
        return Response.redirect(url.toString(), 301);
      }
    }
    if (url.pathname.startsWith("/api/models/")) return handleModel(request, env, ctx, url);
    if (url.pathname === "/api/health") return Response.json({ ok: true, models: Boolean(env.MODELS) });
    return env.ASSETS.fetch(request);
  },
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

async function handleModel(request: Request, env: Env, ctx: ExecutionContextLike, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: CORS });
  const key = decodeURIComponent(url.pathname.slice("/api/models/".length));
  if (!isValidModelKey(key)) return new Response("bad model key", { status: 400, headers: CORS });

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}/api/models/${MESH_VERSION}/${key}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const objectKey = `mesh/${MESH_VERSION}/${key}.bin`;
  if (env.MODELS) {
    const obj = await env.MODELS.get(objectKey);
    if (obj) {
      if (obj.customMetadata?.missing === "1") return missing(key);
      const res = meshResponse(await obj.arrayBuffer(), "r2");
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  }

  // Miss: fetch the WRL from the library mirror and convert.
  const upstream = await fetch(modelRawUrl(key), { headers: { "User-Agent": "pcb23d-model-cache (+https://pcbto3d.com)" } });
  if (upstream.status === 404) {
    if (env.MODELS) ctx.waitUntil(env.MODELS.put(objectKey, new Uint8Array(0), { customMetadata: { missing: "1" } }));
    return missing(key);
  }
  if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: 502, headers: CORS });
  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (length > MAX_WRL_BYTES) return new Response("model too large", { status: 413, headers: CORS });
  const text = await upstream.text();
  let bytes: Uint8Array;
  try {
    const mesh = parseVrml(text);
    if (mesh.triangles === 0) return missing(key);
    bytes = encodeMesh(mesh);
  } catch (error) {
    return new Response(`could not convert model: ${(error as Error).message}`, { status: 422, headers: CORS });
  }
  if (env.MODELS) {
    ctx.waitUntil(
      env.MODELS.put(objectKey, bytes, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { source: modelRawUrl(key) } }),
    );
  }
  const res = meshResponse(bytes, "convert");
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function meshResponse(body: ArrayBuffer | Uint8Array, source: string): Response {
  return new Response(body as BodyInit, {
    headers: {
      ...CORS,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-PCB23D-Model": source,
    },
  });
}

function missing(key: string): Response {
  return new Response(`no library model for ${key}`, {
    status: 404,
    headers: { ...CORS, "Cache-Control": "public, max-age=86400", "X-PCB23D-Model": "missing" },
  });
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

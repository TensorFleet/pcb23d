/**
 * /api/models/<library key>: KiCad 3D models converted to pcb23d's binary mesh format,
 * cached in R2 (bucket MODELS) and the edge cache. Source is the GitHub mirror of
 * kicad-packages3D. `loadModelMesh` is the R2/upstream half without the HTTP layer so
 * the board renderer on this same Worker can pull meshes with one R2 read each.
 */
import { encodeMesh, isValidModelKey, modelRawUrl, parseVrml } from "pcb23d";
import { edgeCache, type Env, type ExecutionContextLike } from "./env";

const MESH_VERSION = "v1";
const MAX_WRL_BYTES = 40 * 1024 * 1024;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export type ModelLookup =
  | { kind: "mesh"; bytes: Uint8Array; source: "r2" | "convert" }
  | { kind: "missing" }
  | { kind: "error"; status: number; message: string };

/** Resolve one library key to mesh bytes: R2 first, then convert the upstream WRL and store it. */
export async function loadModelMesh(
  key: string,
  env: Env,
  ctx: ExecutionContextLike,
): Promise<ModelLookup> {
  const objectKey = `mesh/${MESH_VERSION}/${key}.bin`;
  if (env.MODELS) {
    const obj = await env.MODELS.get(objectKey);
    if (obj) {
      if (obj.customMetadata?.missing === "1") return { kind: "missing" };
      return { kind: "mesh", bytes: new Uint8Array(await obj.arrayBuffer()), source: "r2" };
    }
  }
  const upstream = await fetch(modelRawUrl(key), {
    headers: { "User-Agent": "pcb23d-model-cache (+https://pcbto3d.com)" },
  });
  if (upstream.status === 404) {
    if (env.MODELS)
      ctx.waitUntil(
        env.MODELS.put(objectKey, new Uint8Array(0), { customMetadata: { missing: "1" } }),
      );
    return { kind: "missing" };
  }
  if (!upstream.ok) return { kind: "error", status: 502, message: `upstream ${upstream.status}` };
  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (length > MAX_WRL_BYTES) return { kind: "error", status: 413, message: "model too large" };
  const text = await upstream.text();
  let bytes: Uint8Array;
  try {
    const mesh = parseVrml(text);
    if (mesh.triangles === 0) return { kind: "missing" };
    bytes = encodeMesh(mesh);
  } catch (error) {
    return {
      kind: "error",
      status: 422,
      message: `could not convert model: ${(error as Error).message}`,
    };
  }
  if (env.MODELS) {
    ctx.waitUntil(
      env.MODELS.put(objectKey, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { source: modelRawUrl(key) },
      }),
    );
  }
  return { kind: "mesh", bytes, source: "convert" };
}

export async function handleModel(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  url: URL,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405, headers: CORS });
  const key = decodeURIComponent(url.pathname.slice("/api/models/".length));
  if (!isValidModelKey(key)) return new Response("bad model key", { status: 400, headers: CORS });

  const cache = edgeCache();
  const cacheKey = new Request(`${url.origin}/api/models/${MESH_VERSION}/${key}`, {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const found = await loadModelMesh(key, env, ctx);
  if (found.kind === "missing") return missing(key);
  if (found.kind === "error")
    return new Response(found.message, { status: found.status, headers: CORS });
  const res = meshResponse(found.bytes, found.source);
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

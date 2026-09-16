/**
 * /api/models/<library key>: KiCad 3D models converted to pcb23d's binary mesh format,
 * cached in R2 (bucket MODELS) and the edge cache. Source is the GitHub mirror of
 * kicad-packages3D. `loadModelMesh` is the R2/upstream half without the HTTP layer so
 * the board renderer on this same Worker can pull meshes with one R2 read each.
 */
import { decodeMesh, encodeMesh, isValidModelKey, modelRawUrl, modelStepUrl, parseVrml } from "pcb23d";
import { edgeCache, type Env, type ExecutionContextLike } from "./env";

/** Bump when mesh content changes shape or colour so edge caches and R2 keys roll over. */
const MESH_VERSION = "v2";
/** Edge-cache namespace; bump separately to drop cached responses without touching R2. */
const EDGE_CACHE_VERSION = "e3";
const MAX_MESH_BYTES = 64 * 1024 * 1024;
const MAX_WRL_BYTES = 40 * 1024 * 1024;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-PCB23D-Source",
  "Access-Control-Expose-Headers": "X-PCB23D-Model, X-PCB23D-Source",
  "Access-Control-Max-Age": "86400",
};

export type ModelLookup =
  | { kind: "mesh"; bytes: Uint8Array; source: "r2" | "convert" }
  /** Current-library STEP from GitLab: the edge cannot tessellate it, the client can. */
  | { kind: "step"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "error"; status: number; message: string };

export function meshObjectKey(key: string): string {
  return `mesh/${MESH_VERSION}/${key}.bin`;
}

/** Store a client-supplied mesh (authenticated bulk seeding). */
export async function putModelMesh(request: Request, env: Env, key: string): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.MODELS_ADMIN_TOKEN || token.length < 32 || !timingSafeEqual(token, env.MODELS_ADMIN_TOKEN)) {
    return new Response("unauthorized", { status: 401, headers: CORS });
  }
  if (!env.MODELS) return new Response("no MODELS bucket", { status: 503, headers: CORS });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_MESH_BYTES) return new Response("mesh too large", { status: 413, headers: CORS });
  const bytes = new Uint8Array(await request.arrayBuffer());
  try {
    const mesh = decodeMesh(bytes);
    if (mesh.triangles === 0) return new Response("empty mesh", { status: 422, headers: CORS });
  } catch (error) {
    return new Response(`not a pcb23d mesh: ${(error as Error).message}`, { status: 422, headers: CORS });
  }
  const source = request.headers.get("x-pcb23d-source") ?? "seed";
  await env.MODELS.put(meshObjectKey(key), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { source: source.slice(0, 200) },
  });
  return new Response(null, { status: 204, headers: CORS });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Resolve one library key to mesh bytes: R2 first, then convert the upstream WRL and store it. */
export async function loadModelMesh(
  key: string,
  env: Env,
  ctx: ExecutionContextLike,
): Promise<ModelLookup> {
  const objectKey = meshObjectKey(key);
  if (env.MODELS) {
    const obj = await env.MODELS.get(objectKey);
    if (obj) {
      if (obj.customMetadata?.missing === "1") {
        // re-check upstream once a week in case the model appeared
        const at = Number(obj.customMetadata.missingAt ?? 0);
        if (Date.now() - at < 7 * 86400_000) return { kind: "missing" };
      } else {
        return { kind: "mesh", bytes: new Uint8Array(await obj.arrayBuffer()), source: "r2" };
      }
    }
  }
  const headers = { "User-Agent": "pcb23d-model-cache (+https://pcbto3d.com)" };
  const upstream = await fetch(modelRawUrl(key), { headers });
  if (upstream.status === 404) {
    // The GitHub mirror stopped in 2020; the current library on GitLab ships STEP only.
    const step = await fetch(modelStepUrl(key), { headers });
    if (step.ok) return { kind: "step", bytes: new Uint8Array(await step.arrayBuffer()) };
    if (env.MODELS)
      ctx.waitUntil(
        env.MODELS.put(objectKey, new Uint8Array(0), {
          customMetadata: { missing: "1", missingAt: String(Date.now()) },
        }),
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
  const key = decodeURIComponent(url.pathname.slice("/api/models/".length));
  if (!isValidModelKey(key)) return new Response("bad model key", { status: 400, headers: CORS });
  if (request.method === "PUT") return putModelMesh(request, env, key);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405, headers: CORS });

  const cache = edgeCache();
  const cacheKey = new Request(`${url.origin}/api/models/${EDGE_CACHE_VERSION}/${key}`, {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const found = await loadModelMesh(key, env, ctx);
  if (found.kind === "missing") return missing(key);
  if (found.kind === "error")
    return new Response(found.message, { status: found.status, headers: CORS });
  if (found.kind === "step") {
    // Hand the current-library STEP to the client, which tessellates it with OpenCascade.
    // Not edge-cached: a seeded mesh must take over on the next request.
    return new Response(found.bytes as BodyInit, {
      headers: {
        ...CORS,
        "Content-Type": "application/step",
        "Cache-Control": "public, max-age=3600",
        "X-PCB23D-Model": "step",
      },
    });
  }
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

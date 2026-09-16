/**
 * /api/lcsc/<C-number>: EasyEDA's 3D model for an LCSC part, converted to pcb23d's mesh format
 * and cached in R2 (bucket MODELS, prefix lcsc/). Placement comes back in headers so the client
 * can drop the mesh in with KiCad offset/rotate semantics.
 */
import { easyedaComponentUrl, easyedaModelUrl, encodeMesh, parseEasyedaComponent, parseEasyedaObj, type EasyedaModelInfo } from "pcb23d";
import { CORS } from "./models";
import { edgeCache, type Env, type ExecutionContextLike } from "./env";

const LCSC_VERSION = "v4";
const UA = { "User-Agent": "pcb23d-model-cache (+https://pcbto3d.com)" };

export async function handleLcsc(request: Request, env: Env, ctx: ExecutionContextLike, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: CORS });
  const lcsc = decodeURIComponent(url.pathname.slice("/api/lcsc/".length)).toUpperCase();
  if (!/^C\d{2,9}$/.test(lcsc)) return new Response("expected an LCSC C-number", { status: 400, headers: CORS });

  const cache = edgeCache();
  const cacheKey = new Request(`${url.origin}/api/lcsc/${LCSC_VERSION}/${lcsc}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const objectKey = `lcsc/${LCSC_VERSION}/${lcsc}.bin`;
  if (env.MODELS) {
    const obj = await env.MODELS.get(objectKey);
    if (obj) {
      const meta = obj.customMetadata ?? {};
      if (meta.missing === "1" && Date.now() - Number(meta.missingAt ?? 0) < 7 * 86400_000) return missing(lcsc);
      if (meta.missing !== "1") {
        const d = parseTriple(meta.delta);
        const ps = meta.padSize ? parseTriple(meta.padSize) : undefined;
        const res = meshResponse(await obj.arrayBuffer(), { lcsc, uuid: meta.uuid ?? "", title: meta.title ?? lcsc, offset: parseTriple(meta.offset), rotate: parseTriple(meta.rotate), delta: [d[0], d[1]], ...(ps ? { padSize: [ps[0], ps[1]] as [number, number] } : {}) }, "r2");
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
    }
  }

  const comp = await fetch(easyedaComponentUrl(lcsc), { headers: { ...UA, Accept: "application/json" } });
  if (!comp.ok) return comp.status === 404 ? markMissing(env, ctx, objectKey, lcsc) : new Response(`easyeda ${comp.status}`, { status: 502, headers: CORS });
  let info: EasyedaModelInfo | null;
  try {
    info = parseEasyedaComponent(await comp.json(), lcsc);
  } catch {
    info = null;
  }
  if (!info) return markMissing(env, ctx, objectKey, lcsc);
  const obj = await fetch(easyedaModelUrl(info.uuid), { headers: UA });
  if (!obj.ok) return markMissing(env, ctx, objectKey, lcsc);
  const mesh = parseEasyedaObj(await obj.text());
  if (!mesh) return markMissing(env, ctx, objectKey, lcsc);
  const bytes = encodeMesh(mesh);
  if (env.MODELS) {
    ctx.waitUntil(
      env.MODELS.put(objectKey, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { uuid: info.uuid, title: info.title.slice(0, 120), offset: info.offset.join(","), rotate: info.rotate.join(","), delta: info.delta.join(","), ...(info.padSize ? { padSize: info.padSize.join(",") } : {}), source: easyedaModelUrl(info.uuid) },
      }),
    );
  }
  const res = meshResponse(bytes, info, "convert");
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function parseTriple(s: string | undefined): [number, number, number] {
  const p = (s ?? "0,0,0").split(",").map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

function meshResponse(body: ArrayBuffer | Uint8Array, info: EasyedaModelInfo, source: string): Response {
  return new Response(body as BodyInit, {
    headers: {
      ...CORS,
      "Access-Control-Expose-Headers": "X-PCB23D-Model, X-PCB23D-Offset, X-PCB23D-Rotate, X-PCB23D-Delta, X-PCB23D-PadSize, X-PCB23D-Title, X-PCB23D-Uuid",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=2592000",
      "X-PCB23D-Model": source,
      "X-PCB23D-Offset": info.offset.join(","),
      "X-PCB23D-Rotate": info.rotate.join(","),
      "X-PCB23D-Delta": info.delta.join(","),
      ...(info.padSize ? { "X-PCB23D-PadSize": info.padSize.join(",") } : {}),
      "X-PCB23D-Title": encodeURIComponent(info.title),
      "X-PCB23D-Uuid": info.uuid,
    },
  });
}

function markMissing(env: Env, ctx: ExecutionContextLike, objectKey: string, lcsc: string): Response {
  if (env.MODELS) ctx.waitUntil(env.MODELS.put(objectKey, new Uint8Array(0), { customMetadata: { missing: "1", missingAt: String(Date.now()) } }));
  return missing(lcsc);
}

function missing(lcsc: string): Response {
  return new Response(`no EasyEDA model for ${lcsc}`, { status: 404, headers: { ...CORS, "Cache-Control": "public, max-age=86400", "X-PCB23D-Model": "missing" } });
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

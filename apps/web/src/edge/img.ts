/**
 * /img/gh/{owner}/{repo}[/@ref]        share page: the render up top, og:image set to it
 * /img/gh/{owner}/{repo}[/@ref].jpg    the render itself (also .png; `?view=top|bottom|…`)
 *
 * The board comes from pcbFiddle's snapshot API; the image is cached in the shared R2
 * bucket keyed by commit (see `gh.ts`) and in the edge cache. Library 3D models are read
 * straight from this Worker's mesh cache, one R2 read per part, instead of over HTTP.
 */
import { encode as encodeJpeg } from "jpeg-js";
import { DEFAULT_MODEL_API, isValidModelKey, modelApiUrl, parseColor, pickBoardPath, renderPcb, VIEWS } from "pcb23d";
import { edgeCache, type Env, type ExecutionContextLike } from "./env";
import {
  contentTypeFor,
  DEFAULT_PCBFIDDLE_ORIGIN,
  fiddleClient,
  fiddlePath,
  FiddleError,
  formatImagePath,
  isCommitSha,
  isViewName,
  OG_HEIGHT,
  OG_RENDER,
  OG_WIDTH,
  renderObjectKey,
  type FiddleClient,
  type ImageFormat,
  type ImageSlug,
  type RenderSpec,
} from "./gh";
import { loadModelMesh } from "./models";

/** Opaque card background (pcb23d `--paper-2`); social previews do not composite alpha well. */
const CARD_BACKGROUND = "#151a14";
const JPEG_QUALITY = 88;
/** The camera fit is conservative (AABB corners incl. tall parts); a tight margin fills the card. */
const CARD_MARGIN = 0;
/** Stop pulling library meshes past this many bytes; the rest of the parts draw as boxes. */
const MODEL_BYTE_BUDGET = 40 * 1024 * 1024;
const MAX_BOARD_BYTES = 16 * 1024 * 1024;

const CACHE_PINNED = "public, max-age=31536000, immutable";
const CACHE_REF = "public, max-age=300, s-maxage=600, stale-while-revalidate=3600";
const CACHE_PAGE = "public, max-age=300, s-maxage=600";

export async function handleImage(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  url: URL,
  slug: ImageSlug,
  format: ImageFormat,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain("method not allowed", 405);
  const viewParam = url.searchParams.get("view") ?? OG_RENDER.view;
  if (!isViewName(viewParam)) return plain(`unknown view "${viewParam}"`, 400);
  const spec: RenderSpec = { ...OG_RENDER, view: viewParam, format };
  const cacheControl = isCommitSha(slug.ref) ? CACHE_PINNED : CACHE_REF;

  const cache = edgeCache();
  const cacheKey = new Request(url.href, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const fiddle = fiddleClient(env.PCBFIDDLE_ORIGIN);
  let res: Response;
  try {
    res = await renderFromFiddle(fiddle, env, ctx, slug, spec, cacheControl);
  } catch (error) {
    if (error instanceof FiddleError) return plain(error.message, error.status);
    throw error;
  }
  if (res.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function renderFromFiddle(
  fiddle: FiddleClient,
  env: Env,
  ctx: ExecutionContextLike,
  slug: ImageSlug,
  spec: RenderSpec,
  cacheControl: string,
): Promise<Response> {
  const manifest = await fiddle.manifest(slug);
  const boardPath = pickBoardPath(manifest.files.map((file) => file.path));
  if (!boardPath) {
    return plain(`${manifest.owner}/${manifest.repo} has no .kicad_pcb to render (Eagle and EasyEDA boards are viewer-only)`, 404);
  }
  const key = renderObjectKey(manifest.owner, manifest.repo, manifest.sha, spec);
  if (env.RENDERS) {
    const stored = await env.RENDERS.get(key);
    if (stored) return imageResponse(await stored.arrayBuffer(), spec.format, cacheControl, "r2", manifest.sha);
  }
  const entry = manifest.files.find((file) => file.path === boardPath);
  if (entry && entry.size > MAX_BOARD_BYTES) return plain(`${boardPath} is too large to render here`, 413);
  const bytes = await fiddle.file(manifest, boardPath);
  const image = await renderBoardImage(bytes, boardPath, spec, env, ctx);
  if (env.RENDERS) {
    ctx.waitUntil(
      env.RENDERS.put(key, image, {
        httpMetadata: { contentType: contentTypeFor(spec.format) },
        customMetadata: { board: boardPath, renderedAt: new Date().toISOString(), renderer: "pcbto3d.com" },
      }),
    );
  }
  return imageResponse(image, spec.format, cacheControl, "render", manifest.sha);
}

/** Render one view of a `.kicad_pcb` and encode it. Models come from the local mesh cache. */
export async function renderBoardImage(
  board: Uint8Array,
  fileName: string,
  spec: RenderSpec,
  env: Env,
  ctx: ExecutionContextLike,
): Promise<Uint8Array> {
  const result = await renderPcb(board, {
    fileName,
    views: [{ name: spec.view, ...VIEWS[spec.view], margin: CARD_MARGIN }],
    width: spec.width,
    height: spec.height,
    background: parseColor(CARD_BACKGROUND, [21, 26, 20]),
    png: spec.format === "png",
    fetchModels: { fetch: localModelFetch(env, ctx), apiBase: DEFAULT_MODEL_API, concurrency: 8 },
  });
  const view = result.images[spec.view]!;
  if (spec.format === "png") return view.png;
  const rgba = view.rgba;
  return new Uint8Array(encodeJpeg({ data: rgba.data, width: rgba.width, height: rgba.height }, JPEG_QUALITY).data);
}

/**
 * A `fetch` for `fetchModels` that answers mesh-API URLs from `loadModelMesh` (R2, then the
 * library mirror) and never falls through to raw GitHub for parts the cache already knows
 * are missing. Anything else is a real fetch.
 */
function localModelFetch(env: Env, ctx: ExecutionContextLike): typeof fetch {
  const prefix = modelApiUrl("", DEFAULT_MODEL_API);
  let budget = MODEL_BYTE_BUDGET;
  const missing = () => new Response(null, { status: 404, headers: { "x-pcb23d-model": "missing" } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(prefix)) return fetch(input, init);
    const key = decodeURIComponent(href.slice(prefix.length));
    if (!isValidModelKey(key) || budget <= 0) return missing();
    const found = await loadModelMesh(key, env, ctx);
    if (found.kind !== "mesh") return missing();
    budget -= found.bytes.byteLength;
    return new Response(found.bytes as BodyInit, { headers: { "content-type": "application/octet-stream" } });
  }) as typeof fetch;
}

function imageResponse(body: ArrayBuffer | Uint8Array, format: ImageFormat, cacheControl: string, source: string, sha: string): Response {
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": contentTypeFor(format),
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
      "X-PCB23D-Render": source,
      "X-PCB23D-Sha": sha,
      ETag: `"${sha}:${format}"`,
    },
  });
}

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

/** Fill the static `/img/` template with this repo's links and og tags. */
export async function handlePage(request: Request, env: Env, url: URL, slug: ImageSlug): Promise<Response> {
  const template = await env.ASSETS.fetch(new Request(new URL("/img/", url), { headers: request.headers }));
  if (!template.ok) return template;
  const out = fillPage(template, { origin: url.origin, slug, fiddleOrigin: env.PCBFIDDLE_ORIGIN ?? DEFAULT_PCBFIDDLE_ORIGIN });
  out.headers.set("Cache-Control", CACHE_PAGE);
  return out;
}

/** The bare `/img/` picker: same template, but no board to point og:image at. */
export async function handlePickerPage(request: Request, env: Env): Promise<Response> {
  const template = await env.ASSETS.fetch(request);
  if (!template.ok || !(template.headers.get("content-type") ?? "").includes("text/html")) return template;
  return new HTMLRewriter()
    .on('meta[property^="og:image"], meta[name="twitter:image"]', {
      element(el) {
        el.remove();
      },
    })
    .on('meta[name="twitter:card"]', {
      element(el) {
        el.setAttribute("content", "summary");
      },
    })
    .transform(template);
}

export interface PageFill {
  origin: string;
  slug: ImageSlug;
  /** pcbFiddle origin for the "open in pcbFiddle" link. */
  fiddleOrigin?: string;
}

/** Pure HTMLRewriter pass over the template — exported so tests can run it on a string. */
export function fillPage(template: Response, fill: PageFill): Response {
  const { origin, slug } = fill;
  const name = `${slug.owner}/${slug.repo}${slug.ref ? `@${slug.ref}` : ""}`;
  const pageUrl = origin + formatImagePath(slug);
  const imageUrl = origin + formatImagePath(slug, "jpg");
  const title = `${name} — 3D render · PCB23D`;
  const description = `3D render of the ${slug.owner}/${slug.repo} KiCad board${slug.ref ? ` at ${slug.ref}` : ""}, drawn from the GitHub source.`;
  const github = `https://github.com/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}${
    slug.ref ? `/tree/${slug.ref.split("/").map(encodeURIComponent).join("/")}` : ""
  }`;
  const fiddle = (fill.fiddleOrigin ?? "https://pcbfiddle.com") + fiddlePath(slug);
  const attr = (name: string, value: string) => ({
    element(el: HTMLRewriterTypes.Element) {
      el.setAttribute(name, value);
    },
  });
  const textOf = (value: string) => ({
    element(el: HTMLRewriterTypes.Element) {
      el.setInnerContent(value);
    },
  });
  return new HTMLRewriter()
    .on("title", textOf(title))
    .on('meta[name="description"]', attr("content", description))
    .on('meta[property="og:title"]', attr("content", title))
    .on('meta[property="og:description"]', attr("content", description))
    .on('meta[property="og:url"]', attr("content", pageUrl))
    .on('meta[property="og:image"]', attr("content", imageUrl))
    .on('meta[property="og:image:width"]', attr("content", String(OG_WIDTH)))
    .on('meta[property="og:image:height"]', attr("content", String(OG_HEIGHT)))
    .on('meta[name="twitter:image"]', attr("content", imageUrl))
    .on('link[rel="canonical"]', attr("href", pageUrl))
    .on('[data-slot="render"]', {
      element(el) {
        el.removeAttribute("hidden");
      },
    })
    .on('[data-slot="picker"]', attr("hidden", ""))
    .on('[data-slot="repo"]', textOf(name))
    .on('[data-slot="image"]', {
      element(el) {
        el.setAttribute("src", imageUrl);
        el.setAttribute("alt", `3D render of ${name}`);
      },
    })
    .on('[data-slot="github"]', attr("href", github))
    .on('[data-slot="fiddle"]', attr("href", fiddle))
    .on('[data-slot="download"]', attr("href", imageUrl))
    .on('[data-slot="page-url"]', textOf(pageUrl))
    .on('[data-slot="image-url"]', textOf(imageUrl))
    .on("[data-view]", {
      element(el) {
        const view = el.getAttribute("data-view") ?? "angle";
        el.setAttribute("href", view === "angle" ? imageUrl : `${imageUrl}?view=${view}`);
      },
    })
    .transform(template);
}

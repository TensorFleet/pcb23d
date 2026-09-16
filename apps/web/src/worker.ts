/**
 * Edge script in front of the static site.
 *  - Host canonicalisation: with PRIMARY_HOST set, other hosts 301 to it (production).
 *  - /api/models/<library key>: KiCad 3D models converted to pcb23d's mesh format,
 *    cached in R2 (bucket MODELS) and the edge cache (`edge/models.ts`).
 *  - /img/{gh|cb|gl}/<owner>/<repo>[/@ref][.jpg|.png]: a board render from GitHub,
 *    Codeberg, or GitLab, cached in the R2 bucket shared with pcbfiddle.com, and a share
 *    page whose og:image is that render (`edge/img.ts`). Anything else is served from
 *    the static assets.
 */
import type { Env, ExecutionContextLike } from "./edge/env";
import { parseImagePath } from "./edge/gh";
import { handleImage, handlePage, handlePickerPage } from "./edge/img";
import { handleLcsc } from "./edge/lcsc";
import { handleModel } from "./edge/models";

export type { Env } from "./edge/env";

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
    if (url.pathname.startsWith("/api/lcsc/")) return handleLcsc(request, env, ctx, url);
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        models: Boolean(env.MODELS),
        renders: Boolean(env.RENDERS),
      });
    }
    if (/^\/img\/(gh|cb|gl)(\/|$)/.test(url.pathname)) {
      const parsed = parseImagePath(url.pathname);
      if (!parsed) {
        return new Response("expected /img/{gh|cb|gl}/<owner>/<repo>[/@ref][.jpg|.png]", {
          status: 400,
        });
      }
      if (parsed.format) return handleImage(request, env, ctx, url, parsed.slug, parsed.format);
      return handlePage(request, env, url, parsed.slug);
    }
    if (url.pathname === "/img" || url.pathname === "/img/") return handlePickerPage(request, env);
    return env.ASSETS.fetch(request);
  },
};

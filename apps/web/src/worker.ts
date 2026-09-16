/**
 * Production edge script. Static assets serve the site; this only canonicalises hosts:
 * pcb23d.com, www.pcb23d.com, and www.pcbto3d.com redirect to https://pcbto3d.com with the
 * path kept. Set PRIMARY_HOST to enable; without it (local, staging) every host is served.
 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PRIMARY_HOST?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const primary = env.PRIMARY_HOST;
    if (primary) {
      const url = new URL(request.url);
      const host = url.hostname;
      const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".workers.dev");
      if (host !== primary && !local) {
        url.hostname = primary;
        url.protocol = "https:";
        url.port = "";
        return Response.redirect(url.toString(), 301);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

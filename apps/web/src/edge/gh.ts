/**
 * Board renders shared with pcbfiddle.com.
 *
 * pcbFiddle clones public GitHub, Codeberg, and GitLab repos into the
 * `fabplane-opensource` R2 bucket under `{gh|cb|gl}/{owner}/{repo}/{sha}/…`. This Worker
 * asks pcbFiddle for the snapshot (so a repo is cloned once), renders the board, and
 * writes the image next to that snapshot. pcbFiddle serves the same object as its
 * og:image, so a render is produced once per commit no matter which site asked first.
 *
 *   {gh|cb|gl}/{owner}/{repo}/{sha}/renders/{view}-{w}x{h}-v{RENDER_VERSION}.{jpg|png}
 *
 * Owner and repo are lowercased in keys, matching pcbFiddle's `repoPrefix`. Bump
 * RENDER_VERSION when renderer output changes enough that old images should be redrawn.
 */
import { VIEWS, type ViewName } from "pcb23d";
import { fiddlePath, type ImageFormat, type ImageSlug, type SourceKind } from "./hosts";

export {
  fiddlePath,
  formatImagePath,
  isCommitSha,
  isSourceKind,
  kindOf,
  parseImagePath,
  parsePickerInput,
  sourceUrl,
  SOURCE_KINDS,
  SOURCE_LABEL,
  SOURCE_ORIGIN,
  type ImageFormat,
  type ImageSlug,
  type SourceKind,
} from "./hosts";

export const RENDER_VERSION = 2;

/** Social-card size: what og:image consumers expect. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const DEFAULT_VIEW: ViewName = "angle";

export interface RenderSpec {
  view: ViewName;
  width: number;
  height: number;
  format: ImageFormat;
}

export const OG_RENDER: RenderSpec = {
  view: DEFAULT_VIEW,
  width: OG_WIDTH,
  height: OG_HEIGHT,
  format: "jpg",
};

export function isViewName(name: string): name is ViewName {
  return Object.prototype.hasOwnProperty.call(VIEWS, name);
}

export function renderObjectKey(
  owner: string,
  repo: string,
  sha: string,
  spec: RenderSpec,
  kind: SourceKind = "gh",
): string {
  return `${kind}/${owner.toLowerCase()}/${repo.toLowerCase()}/${sha}/renders/${spec.view}-${spec.width}x${spec.height}-v${RENDER_VERSION}.${spec.format}`;
}

export function contentTypeFor(format: ImageFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/** Subset of pcbFiddle's `/api/{kind}/{owner}/{repo}[/@ref]` manifest that the renderer needs. */
export interface FiddleManifest {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  description: string | null;
  htmlUrl: string;
  files: { path: string; size: number; url: string }[];
  openPath: string | null;
}

export class FiddleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface FiddleClient {
  manifest(slug: ImageSlug): Promise<FiddleManifest>;
  file(manifest: FiddleManifest, path: string): Promise<Uint8Array>;
}

export const DEFAULT_PCBFIDDLE_ORIGIN = "https://pcbfiddle.com";

/** Talk to pcbFiddle's public clone-on-miss API. File URLs in the manifest are origin-relative. */
export function fiddleClient(
  origin = DEFAULT_PCBFIDDLE_ORIGIN,
  f: typeof fetch = fetch,
): FiddleClient {
  const base = origin.replace(/\/$/, "");
  const headers = {
    "User-Agent": "pcb23d-render (+https://pcbto3d.com)",
    Accept: "application/json",
  };
  return {
    async manifest(slug) {
      const res = await f(`${base}/api${fiddlePath(slug)}`, { headers });
      if (!res.ok) {
        let message = `pcbFiddle ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // non-JSON error body
        }
        throw new FiddleError(message, res.status === 404 || res.status === 422 ? res.status : 502);
      }
      return (await res.json()) as FiddleManifest;
    },
    async file(manifest, path) {
      const entry = manifest.files.find((file) => file.path === path);
      if (!entry) throw new FiddleError(`${path} is not in the snapshot`, 404);
      const res = await f(new URL(entry.url, base).href, {
        headers: { "User-Agent": headers["User-Agent"] },
      });
      if (!res.ok)
        throw new FiddleError(`could not read ${path} from pcbFiddle (${res.status})`, 502);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

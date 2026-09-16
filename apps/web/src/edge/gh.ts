/**
 * GitHub board renders shared with pcbfiddle.com.
 *
 * pcbFiddle already clones public repos into the `fabplane-opensource` R2 bucket under
 * `gh/{owner}/{repo}/{sha}/…`. This Worker asks pcbFiddle for the snapshot (so a repo is
 * cloned once, with its GitHub-quota-free path), renders the board, and writes the image
 * next to that snapshot. pcbFiddle serves the same object as its og:image, so a render is
 * produced once per commit no matter which site asked first.
 *
 *   gh/{owner}/{repo}/{sha}/renders/{view}-{w}x{h}-v{RENDER_VERSION}.{jpg|png}
 *
 * Owner and repo are lowercased in keys, matching pcbFiddle's `repoPrefix`. Bump
 * RENDER_VERSION when renderer output changes enough that old images should be redrawn.
 */
import { VIEWS, type ViewName } from "pcb23d";

export const RENDER_VERSION = 1;

/** Social-card size: what og:image consumers expect. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const DEFAULT_VIEW: ViewName = "angle";

export type ImageFormat = "jpg" | "png";

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

export interface ImageSlug {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Undefined means the repository default branch. */
  ref?: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\-/]{1,255}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

export function isCommitSha(ref: string | undefined): ref is string {
  return !!ref && SHA_RE.test(ref);
}

export function isViewName(name: string): name is ViewName {
  return Object.prototype.hasOwnProperty.call(VIEWS, name);
}

/**
 * Parse `/img/gh/{owner}/{repo}[/@{ref}][.jpg|.png]`. Returns the slug and, when the path
 * ended in an image extension, the format; `null` for anything that is not a valid slug.
 */
export function parseImagePath(
  pathname: string,
): { slug: ImageSlug; format: ImageFormat | null } | null {
  let path = pathname.replace(/\/+$/, "");
  let format: ImageFormat | null = null;
  const ext = /\.(jpe?g|png)$/i.exec(path);
  if (ext) {
    format = ext[1]!.toLowerCase() === "png" ? "png" : "jpg";
    path = path.slice(0, -ext[0].length);
  }
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "img" || parts[1] !== "gh") return null;
  let owner: string;
  let repo: string;
  let ref: string | undefined;
  try {
    owner = decodeURIComponent(parts[2] ?? "");
    repo = decodeURIComponent(parts[3] ?? "");
    const rest = parts.slice(4).map(decodeURIComponent);
    if (rest.length) {
      if (!rest[0]!.startsWith("@")) return null;
      ref = [rest[0]!.slice(1), ...rest.slice(1)].join("/");
    }
  } catch {
    return null;
  }
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  if (ref !== undefined && (!REF_RE.test(ref) || ref.includes("..") || ref.endsWith("/")))
    return null;
  return { slug: ref ? { owner, repo, ref } : { owner, repo }, format };
}

/** `/img/gh/owner/repo[/@ref]` plus an optional image extension. */
export function formatImagePath(slug: ImageSlug, format?: ImageFormat): string {
  const segs = ["/img/gh", encodeURIComponent(slug.owner), encodeURIComponent(slug.repo)];
  if (slug.ref) segs.push(`@${slug.ref.split("/").map(encodeURIComponent).join("/")}`);
  return segs.join("/") + (format ? `.${format}` : "");
}

/** pcbFiddle slug for the same repo (`/gh/owner/repo[/@ref]`). */
export function fiddlePath(slug: ImageSlug): string {
  return formatImagePath(slug).slice("/img".length);
}

export function renderObjectKey(
  owner: string,
  repo: string,
  sha: string,
  spec: RenderSpec,
): string {
  return `gh/${owner.toLowerCase()}/${repo.toLowerCase()}/${sha}/renders/${spec.view}-${spec.width}x${spec.height}-v${RENDER_VERSION}.${spec.format}`;
}

export function contentTypeFor(format: ImageFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/** Subset of pcbFiddle's `/api/gh/{owner}/{repo}[/@ref]` manifest that the renderer needs. */
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

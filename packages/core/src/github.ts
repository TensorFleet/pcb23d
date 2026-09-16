/**
 * Load a board straight from GitHub without a server. Uses the REST API for the tree listing
 * (CORS-enabled, 60 requests/hour unauthenticated) and raw.githubusercontent.com for content.
 * Works in browsers, Bun, and Node.
 */
import { pickBoardPath } from "./input";
import { kicadKind } from "./kicad/files";

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Undefined means the default branch. */
  ref?: string;
  /** Sub-directory or file path inside the repo. */
  path?: string;
}

export interface RemoteBoard {
  /** Board bytes (`.kicad_pcb` text, or a zip). */
  bytes: Uint8Array;
  /** Repo-relative path of the board, or the URL's file name. */
  path: string;
  /** URL the bytes came from. */
  url: string;
  ref?: string;
  archivePaths: string[];
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** True for anything that looks like a URL or `owner/repo` shorthand rather than a local file. */
export function isRemoteInput(input: string): boolean {
  const s = input.trim();
  if (/^https?:\/\//i.test(s) || /^(www\.)?github\.com\//i.test(s) || /^gh:/i.test(s)) return true;
  return /^[\w.-]+\/[\w.-]+$/.test(s) && !/\.(zip|kicad_pcb)$/i.test(s) && !s.startsWith(".");
}

/** Parse a GitHub URL (repo, tree, blob, raw) or `owner/repo[@ref][/path]` shorthand. */
export function parseGithubUrl(input: string): GithubRef | null {
  let s = input.trim().replace(/^gh:/i, "");
  if (!s) return null;
  if (/^(www\.)?github\.com\//i.test(s) || /^raw\.githubusercontent\.com\//i.test(s)) s = `https://${s}`;
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const host = url.hostname.toLowerCase();
    if (host === "raw.githubusercontent.com") {
      const [owner, repo, ref, ...rest] = parts;
      if (!owner || !repo || !ref) return null;
      return { owner, repo, ref, path: rest.join("/") };
    }
    if (!GITHUB_HOSTS.has(host)) return null;
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    const kind = parts[2];
    const ref = parts[3];
    if ((kind === "tree" || kind === "blob" || kind === "raw") && ref) {
      const path = parts.slice(4).join("/");
      return { owner, repo, ref, ...(path ? { path } : {}) };
    }
    if (kind === "commit" && ref) return { owner, repo, ref };
    return { owner, repo };
  }
  const m = /^([\w.-]+)\/([\w.-]+?)(?:@([^/]+))?(?:\/(.+))?$/.exec(s);
  if (!m) return null;
  const out: GithubRef = { owner: m[1]!, repo: m[2]!.replace(/\.git$/, "") };
  if (m[3]) out.ref = m[3];
  if (m[4]) out.path = m[4];
  return out;
}

export interface FetchOptions {
  fetch?: typeof fetch;
  /** GitHub token to lift the API rate limit (server/CLI use only). */
  token?: string;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** Fetch the board for a GitHub reference. Directories are searched for the project's board. */
export async function fetchGithubBoard(ref: GithubRef, opts: FetchOptions = {}): Promise<RemoteBoard> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const api = async <T>(path: string): Promise<T> => {
    const res = await f(`https://api.github.com${path}`, { headers });
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub API rate limit reached (60 requests/hour without a token). Try again later or drop the files directly.");
    }
    if (res.status === 404) throw new Error(`GitHub: ${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ""} not found (private repos are not supported)`);
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  // Direct file link: no API needed.
  if (ref.path && /\.(kicad_pcb|zip)$/i.test(ref.path) && ref.ref) {
    return rawFile(f, ref, ref.ref, ref.path);
  }

  let gitRef = ref.ref;
  if (!gitRef) {
    const repo = await api<{ default_branch: string }>(`/repos/${ref.owner}/${ref.repo}`);
    gitRef = repo.default_branch;
  }
  if (ref.path && /\.(kicad_pcb|zip)$/i.test(ref.path)) return rawFile(f, ref, gitRef, ref.path);

  const tree = await api<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(gitRef)}?recursive=1`,
  );
  const prefix = ref.path ? ref.path.replace(/\/+$/, "") + "/" : "";
  let paths = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
  if (prefix) paths = paths.filter((p) => p.startsWith(prefix));
  const board = pickBoardPath(paths);
  if (!board) {
    const kicad = paths.filter((p) => kicadKind(p, paths) !== "other").slice(0, 5);
    throw new Error(
      `no .kicad_pcb in ${ref.owner}/${ref.repo}${prefix ? `/${prefix}` : ""}${tree.truncated ? " (listing truncated)" : ""}${kicad.length ? `; KiCad files seen: ${kicad.join(", ")}` : ""}`,
    );
  }
  const out = await rawFile(f, ref, gitRef, board);
  out.archivePaths = paths;
  return out;
}

async function rawFile(f: typeof fetch, ref: GithubRef, gitRef: string, path: string): Promise<RemoteBoard> {
  const url = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(gitRef)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await f(url);
  if (!res.ok) throw new Error(`could not download ${path} (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path, url, ref: gitRef, archivePaths: [] };
}

/** Fetch any URL that serves a `.kicad_pcb` or zip directly (CORS permitting in browsers). */
export async function fetchRemoteBoard(input: string, opts: FetchOptions = {}): Promise<RemoteBoard> {
  const gh = parseGithubUrl(input);
  if (gh) return fetchGithubBoard(gh, opts);
  const f = opts.fetch ?? fetch;
  const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const res = await f(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "board.kicad_pcb");
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: name, url, archivePaths: [] };
}

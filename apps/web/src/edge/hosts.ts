/**
 * Host prefixes shared with pcbFiddle (`gh` GitHub, `cb` Codeberg, `gl` GitLab.com).
 *
 * Image URLs are `/img/{kind}/{owner}/{repo}[/@ref][.jpg|.png]`. pcbFiddle clones the
 * same slug under `/api/{kind}/…` and stores the snapshot (and this Worker's render)
 * at `{kind}/{owner}/{repo}/{sha}/…`.
 */

export const SOURCE_KINDS = ["gh", "cb", "gl"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  gh: "GitHub",
  cb: "Codeberg",
  gl: "GitLab",
};

export const SOURCE_ORIGIN: Record<SourceKind, string> = {
  gh: "https://github.com",
  cb: "https://codeberg.org",
  gl: "https://gitlab.com",
};

const HOST_KIND: Record<string, SourceKind> = {
  "github.com": "gh",
  "www.github.com": "gh",
  "codeberg.org": "cb",
  "www.codeberg.org": "cb",
  "gitlab.com": "gl",
  "www.gitlab.com": "gl",
};

export type ImageFormat = "jpg" | "png";

export interface ImageSlug {
  kind?: SourceKind;
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Undefined means the repository default branch. */
  ref?: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\-/]{1,255}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const SOURCE_KIND_SET = new Set<string>(SOURCE_KINDS);

export function isSourceKind(value: string): value is SourceKind {
  return SOURCE_KIND_SET.has(value);
}

export function kindOf(slug: ImageSlug): SourceKind {
  return slug.kind ?? "gh";
}

export function isCommitSha(ref: string | undefined): ref is string {
  return !!ref && SHA_RE.test(ref);
}

/**
 * Parse `/img/{gh|cb|gl}/{owner}/{repo}[/@{ref}][.jpg|.png]`. Returns the slug and, when
 * the path ended in an image extension, the format; `null` for anything that is not a
 * valid slug.
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
  if (parts[0] !== "img" || !isSourceKind(parts[1] ?? "")) return null;
  const kind = parts[1] as SourceKind;
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
  const slug: ImageSlug = ref ? { kind, owner, repo, ref } : { kind, owner, repo };
  return { slug, format };
}

/** `/img/{kind}/owner/repo[/@ref]` plus an optional image extension. */
export function formatImagePath(slug: ImageSlug, format?: ImageFormat): string {
  const segs = [
    `/img/${kindOf(slug)}`,
    encodeURIComponent(slug.owner),
    encodeURIComponent(slug.repo),
  ];
  if (slug.ref) segs.push(`@${slug.ref.split("/").map(encodeURIComponent).join("/")}`);
  return segs.join("/") + (format ? `.${format}` : "");
}

/** pcbFiddle slug for the same repo (`/{kind}/owner/repo[/@ref]`). */
export function fiddlePath(slug: ImageSlug): string {
  return formatImagePath(slug).slice("/img".length);
}

/** Canonical page on GitHub, Codeberg, or GitLab for this slug. */
export function sourceUrl(slug: ImageSlug): string {
  const kind = kindOf(slug);
  const base = `${SOURCE_ORIGIN[kind]}/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`;
  if (!slug.ref) return base;
  const ref = slug.ref.split("/").map(encodeURIComponent).join("/");
  if (kind === "cb") {
    const marker = isCommitSha(slug.ref) ? "commit" : "branch";
    return `${base}/src/${marker}/${ref}`;
  }
  if (kind === "gl") return `${base}/-/tree/${ref}`;
  return `${base}/tree/${ref}`;
}

/**
 * Turn a pasted forge URL, `/img/{kind}/…` path, `{kind}/owner/repo`, or GitHub
 * `owner/repo` shorthand into a slug. Board paths after the ref are dropped — the
 * image is always the repo's picked `.kicad_pcb`.
 */
export function parsePickerInput(raw: string): ImageSlug | null {
  let value = raw.trim();
  if (!value) return null;
  try {
    value = value.replace(/^https?:\/\//i, "");
    value = value.replace(/^(www\.)?pcbto3d\.com\//i, "");
    if (value.toLowerCase().startsWith("img/")) value = value.slice(4);
    value = value.replace(/\.(jpe?g|png)$/i, "");

    let kind: SourceKind | undefined;
    const prefix = /^(gh|cb|gl)\//i.exec(value);
    if (prefix) {
      kind = prefix[1]!.toLowerCase() as SourceKind;
      value = value.slice(prefix[0].length);
    } else {
      const host = value.split("/")[0]?.toLowerCase() ?? "";
      if (host in HOST_KIND) {
        kind = HOST_KIND[host];
        value = value.slice(host.length + (value.length > host.length ? 1 : 0));
      }
    }
    kind ??= "gh";

    const segs = value
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const owner = segs[0];
    const repo = segs[1]?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;

    const ref = refFromHostPath(kind, segs.slice(2));
    if (ref !== undefined && (!REF_RE.test(ref) || ref.includes("..") || ref.endsWith("/")))
      return null;
    return ref ? { kind, owner, repo, ref } : { kind, owner, repo };
  } catch {
    return null;
  }
}

function refFromHostPath(kind: SourceKind, rest: string[]): string | undefined {
  const [marker, ...tail] = rest;
  if (!marker) return undefined;
  if (marker.startsWith("@")) return [marker.slice(1), ...tail].join("/") || undefined;

  if (kind === "cb" && marker === "src") {
    const refKind = tail[0];
    const ref = tail[1];
    if ((refKind === "branch" || refKind === "commit" || refKind === "tag") && ref) return ref;
    return undefined;
  }
  if (kind === "gl" && marker === "-") {
    const glKind = tail[0];
    const ref = tail[1];
    if ((glKind === "tree" || glKind === "blob" || glKind === "raw" || glKind === "commit") && ref)
      return ref;
    return undefined;
  }
  if (marker === "tree" || marker === "blob" || marker === "raw") return tail[0];
  if (marker === "commit") return tail[0];
  return undefined;
}

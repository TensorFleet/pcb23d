export type KicadFileKind = "project" | "board" | "schematic" | "library" | "other";

const MAX_KICAD_BYTES = 8 * 1024 * 1024;
const MAX_SUPPORTING_BYTES = 1024 * 1024;

export function kicadKind(path: string, allPaths: readonly string[] = []): KicadFileKind {
  const n = path.replace(/\\/g, "/").toLowerCase();
  const base = n.slice(n.lastIndexOf("/") + 1);
  if (base.endsWith(".kicad_pro")) return "project";
  if (base.endsWith(".kicad_pcb") || base.endsWith(".brd")) return "board";
  if (base.endsWith(".kicad_sch") || base.endsWith(".sch")) return "schematic";
  if (base.endsWith(".pro") && kiCad5Companion(path, allPaths)) return "project";
  if (
    base.endsWith(".kicad_mod") ||
    base.endsWith(".kicad_sym") ||
    base === "fp-lib-table" ||
    base === "sym-lib-table" ||
    n.includes(".pretty/")
  ) {
    return "library";
  }
  return "other";
}

/** KiCad 5 used `.pro`; qmake uses the same suffix, so require a sibling board or schematic. */
function kiCad5Companion(path: string, allPaths: readonly string[]): boolean {
  const stem = path.replace(/\\/g, "/").replace(/\.pro$/i, "");
  return allPaths.some((candidate) => {
    const n = candidate.replace(/\\/g, "/");
    return n === `${stem}.kicad_pcb` || n === `${stem}.kicad_sch` || n === `${stem}.sch`;
  });
}

export function isKicadDesignFile(path: string, allPaths: readonly string[] = []): boolean {
  const kind = kicadKind(path, allPaths);
  return kind === "project" || kind === "board" || kind === "schematic" || kind === "library";
}

/** Skip VCS, dependencies, and bulky manufacturing dumps when cloning a repo into R2. */
export function shouldKeepPath(path: string, size: number, allPaths: readonly string[] = []): boolean {
  const n = path.replace(/\\/g, "/");
  if (n.startsWith(".git/") || n.includes("/.git/")) return false;
  if (n.includes("/node_modules/") || n.startsWith("node_modules/")) return false;
  if (n.includes("/.github/workflows/")) return false;
  const kind = kicadKind(n, allPaths);
  if (kind !== "other") return size <= MAX_KICAD_BYTES;
  return /\.kicad_prl$/i.test(n) && size <= MAX_SUPPORTING_BYTES;
}

export function pickMainDocument(paths: string[]): string | undefined {
  const ranked = (p: string) => {
    const kind = kicadKind(p, paths);
    if (kind === "project") return 0;
    if (kind === "board") return 1;
    if (kind === "schematic") return 2;
    return 9;
  };
  const depth = (p: string) => p.replace(/\\/g, "/").split("/").length;
  return [...paths]
    .filter((p) => ranked(p) < 9)
    .sort((a, b) => ranked(a) - ranked(b) || depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))[0];
}

export function hasOpenableDocument(paths: string[]): boolean {
  return pickMainDocument(paths) !== undefined;
}

/**
 * Design files next to the opened document. Variants and leftover libraries stay
 * in the file tree but are not prefetched — that used to stampede GitHub/R2.
 */
export function filesForOpen(paths: string[], openPath?: string | null): string[] {
  const main = openPath && paths.includes(openPath) ? openPath : pickMainDocument(paths);
  const dir = main?.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  return paths.filter((path) => {
    if (dir && !path.startsWith(dir)) return false;
    const rel = dir ? path.slice(dir.length) : path;
    if (rel.startsWith("variants/")) return false;
    if (rel.includes("/")) return false;
    const kind = kicadKind(path, paths);
    if (kind === "project" || kind === "board" || kind === "schematic") return true;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base === "fp-lib-table" || base === "sym-lib-table";
  });
}

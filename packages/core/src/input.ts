/**
 * Accepts whatever the user hands over — a zip of a KiCad project, a single `.kicad_pcb`, or
 * board text — and finds the board file to render.
 */
import { unzipSync } from "fflate";
import { kicadKind, pickMainDocument } from "./kicad/files";
import type { ProjectFiles } from "./models/refs";

export interface BoardSource {
  /** Path inside the archive, or the given file name. */
  path: string;
  text: string;
  /** Every path that was in the archive (empty for a bare board). */
  archivePaths: string[];
  /** Archive contents when the input was a zip, for project-local 3D models. */
  files?: Record<string, Uint8Array>;
}

/** Project-file reader for a zip source (undefined for bare boards). */
export function projectFromSource(source: BoardSource): ProjectFiles | undefined {
  const files = source.files;
  if (!files) return undefined;
  return { paths: source.archivePaths, read: async (path) => files[path] ?? null };
}

export function boardDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const ZIP_MAGIC = [0x50, 0x4b];

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === ZIP_MAGIC[0] && bytes[1] === ZIP_MAGIC[1];
}

/** Pick the board to render from a list of archive paths. Prefers the project's own board. */
export function pickBoardPath(paths: string[]): string | undefined {
  const boards = paths.filter((p) => /\.kicad_pcb$/i.test(p) && !isJunkPath(p));
  if (boards.length === 0) return undefined;
  const main = pickMainDocument(paths.filter((p) => !isJunkPath(p)));
  if (main && kicadKind(main, paths) === "project") {
    const stem = main.replace(/\.(kicad_pro|pro)$/i, "");
    const sibling = boards.find((b) => b.replace(/\.kicad_pcb$/i, "") === stem);
    if (sibling) return sibling;
  }
  const depth = (p: string) => p.split("/").length;
  const backup = (p: string) => (/-backups?\//i.test(p) || /autosave|\.bak/i.test(p) ? 1 : 0);
  return [...boards].sort(
    (a, b) => backup(a) - backup(b) || depth(a) - depth(b) || a.length - b.length || a.localeCompare(b),
  )[0];
}

function isJunkPath(p: string): boolean {
  return /(^|\/)(__MACOSX|\.git|node_modules)\//.test(p) || /(^|\/)\._/.test(p);
}

export function readBoardSource(input: Uint8Array | string, fileName = "board.kicad_pcb"): BoardSource {
  if (typeof input === "string") return { path: fileName, text: input, archivePaths: [] };
  if (isZip(input)) {
    const files = unzipSync(input);
    const paths = Object.keys(files).filter((p) => !p.endsWith("/"));
    const path = pickBoardPath(paths);
    if (!path) {
      const hint = paths.filter((p) => kicadKind(p, paths) !== "other").slice(0, 5);
      throw new Error(
        `no .kicad_pcb found in the archive (${paths.length} files${hint.length ? `; KiCad files: ${hint.join(", ")}` : ""})`,
      );
    }
    return { path, text: new TextDecoder().decode(files[path]!), archivePaths: paths, files };
  }
  return { path: fileName, text: new TextDecoder().decode(input), archivePaths: [] };
}

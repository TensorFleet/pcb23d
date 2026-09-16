declare module "occt-import-js" {
  import type { OcctModuleLike } from "pcb23d";
  /** Emscripten factory for the OpenCascade import module. */
  export default function occtimportjs(options?: { locateFile?: (file: string) => string }): Promise<OcctModuleLike>;
}

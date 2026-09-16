/** Minimal Workers runtime typings so the edge script compiles alongside the DOM-typed site. */
export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** `pcb23d-models`: converted KiCad library meshes. */
  MODELS?: R2BucketLike;
  /**
   * `fabplane-opensource`: the git-snapshot bucket pcbfiddle.com and fabplane.com share.
   * Board renders are written next to the snapshot they came from (see `edge/gh.ts`).
   */
  RENDERS?: R2BucketLike;
  PRIMARY_HOST?: string;
  /** Bearer token that allows PUT /api/models/<key> (bulk seeding from a KiCad install). */
  MODELS_ADMIN_TOKEN?: string;
  /** pcbFiddle origin used to clone + read GitHub boards (`https://pcbfiddle.com`). */
  PCBFIDDLE_ORIGIN?: string;
}

/** Edge cache handle; `caches.default` is not in the DOM lib. */
export function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

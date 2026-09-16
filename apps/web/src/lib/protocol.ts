import type { BoardStats, ViewName, ViewSpec } from "pcb23d";

export interface SceneRequestOptions {
  maskColor?: string;
  silkColor?: string;
  copperFinish?: string;
  components: boolean;
  /** Fetch real 3D models for footprints (library WRL via /api/models). */
  models: boolean;
  pixelsPerMm: number;
}

export interface RenderRequest {
  type: "render";
  id: number;
  /** New board bytes; omit to reuse the board the worker already parsed. */
  bytes?: ArrayBuffer;
  fileName?: string;
  views: { name: string; spec: ViewName | ViewSpec }[];
  width: number;
  height: number;
  supersample: number;
  scene: SceneRequestOptions;
}

export interface BoardSummary {
  path: string;
  title?: string;
  widthMm: number;
  heightMm: number;
  thickness: number;
  layers: string[];
  stats: BoardStats;
  components: number;
  outlineFromEdgeCuts: boolean;
  parseMs: number;
}

export type WorkerMessage =
  | { type: "parsed"; id: number; board: BoardSummary }
  | { type: "models"; id: number; done: number; total: number }
  | { type: "image"; id: number; name: string; width: number; height: number; png: ArrayBuffer; ms: number }
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string };

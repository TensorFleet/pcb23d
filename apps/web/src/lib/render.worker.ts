/// <reference lib="webworker" />
import { buildScene, encodePng, fetchModels, modelKeys, parseBoard, readBoardSource, renderMesh, resolveView, type Board, type ModelMesh, type Scene } from "pcb23d";
import type { RenderRequest, WorkerMessage } from "./protocol";

let board: Board | null = null;
let boardPath = "";
let scene: Scene | null = null;
let sceneKey = "";
/** Converted models, kept for the life of the worker (keys are library paths). */
const modelCache = new Map<string, ModelMesh>();
const missingModels = new Set<string>();

const post = (msg: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  void handle(event.data);
};

async function handle(req: RenderRequest): Promise<void> {
  if (req.type !== "render") return;
  try {
    if (req.bytes) {
      const t0 = performance.now();
      const source = readBoardSource(new Uint8Array(req.bytes), req.fileName);
      board = parseBoard(source.text);
      boardPath = source.path;
      scene = null;
      sceneKey = "";
      const b = board.bounds;
      post({
        type: "parsed",
        id: req.id,
        board: {
          path: boardPath,
          ...(board.title ? { title: board.title } : {}),
          widthMm: Math.round((b.maxX - b.minX) * 100) / 100,
          heightMm: Math.round((b.maxY - b.minY) * 100) / 100,
          thickness: board.thickness,
          layers: board.copperLayers,
          stats: board.stats,
          components: board.components.length,
          outlineFromEdgeCuts: board.outlineFromEdgeCuts,
          parseMs: Math.round(performance.now() - t0),
        },
      });
    }
    if (!board) throw new Error("no board loaded");
    let models: Map<string, ModelMesh> | undefined;
    if (req.scene.models && req.scene.components) {
      const wanted = modelKeys(board).filter((k) => !modelCache.has(k) && !missingModels.has(k));
      if (wanted.length) {
        post({ type: "models", id: req.id, done: 0, total: wanted.length });
        const fetched = await fetchModels(wanted, {
          apiBase: `${self.location.origin}/api/models`,
          concurrency: 6,
          onProgress: (done, total) => post({ type: "models", id: req.id, done, total }),
        });
        for (const k of wanted) {
          const m = fetched.get(k);
          if (m) modelCache.set(k, m);
          else missingModels.add(k);
        }
      }
      models = new Map();
      for (const k of modelKeys(board)) {
        const m = modelCache.get(k);
        if (m) models.set(k, m);
      }
    }
    const key = JSON.stringify(req.scene);
    if (!scene || key !== sceneKey) {
      const { maskColor, silkColor, copperFinish, components, pixelsPerMm } = req.scene;
      scene = buildScene(board, {
        components,
        pixelsPerMm,
        ...(models ? { models } : {}),
        ...(maskColor ? { maskColor } : {}),
        ...(silkColor ? { silkColor } : {}),
        ...(copperFinish ? { copperFinish } : {}),
      });
      sceneKey = key;
    }
    for (const view of req.views) {
      const t0 = performance.now();
      const rgba = renderMesh(scene.mesh, resolveView(view.spec), {
        width: req.width,
        height: req.height,
        supersample: req.supersample,
        background: "transparent",
      });
      const png = encodePng(rgba, 4);
      const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      post(
        { type: "image", id: req.id, name: view.name, width: rgba.width, height: rgba.height, png: buffer, ms: Math.round(performance.now() - t0) },
        [buffer],
      );
    }
    post({ type: "done", id: req.id });
  } catch (error) {
    post({ type: "error", id: req.id, message: error instanceof Error ? error.message : String(error) });
  }
}

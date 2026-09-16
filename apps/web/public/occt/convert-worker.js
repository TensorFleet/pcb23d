// Classic worker: loads OpenCascade (occt-import-js) and tessellates STEP files on request.
// Kept as plain JS outside the bundle because the emscripten glue is not an ES module.
/* global occtimportjs */
importScripts("/occt/occt-import-js.js");
let ready = null;
function load() {
  if (!ready) ready = occtimportjs({ locateFile: (f) => `/occt/${f}` });
  return ready;
}
self.onmessage = async (event) => {
  const { id, bytes, params } = event.data;
  try {
    const occt = await load();
    const result = occt.ReadStepFile(new Uint8Array(bytes), params || null);
    // Return only what the adapter needs, with transferable buffers.
    const meshes = result.meshes.map((m) => ({
      attributes: { position: { array: m.attributes.position.array } },
      index: m.index ? { array: m.index.array } : undefined,
      color: m.color ? Array.from(m.color) : undefined,
    }));
    const transfer = [];
    for (const m of meshes) {
      if (m.attributes.position.array.buffer) transfer.push(m.attributes.position.array.buffer);
      if (m.index && m.index.array.buffer) transfer.push(m.index.array.buffer);
    }
    self.postMessage({ id, success: result.success, meshes }, transfer);
  } catch (error) {
    self.postMessage({ id, success: false, meshes: [], error: String(error && error.message ? error.message : error) });
  }
};

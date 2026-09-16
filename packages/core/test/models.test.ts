import { describe, expect, test } from "bun:test";
import { decodeMesh, encodeMesh } from "../src/models/mesh-format";
import { fetchModels, modelKey, modelRawUrl } from "../src/models/refs";
import { parseVrml } from "../src/models/vrml";
import { buildScene, modelKeys, parseBoard, renderMesh, VIEWS } from "../src/index";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("modelKey", () => {
  test("maps KiCad variables and STEP paths to library WRL keys", () => {
    expect(modelKey("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step")).toBe("Resistor_SMD.3dshapes/R_0402_1005Metric.wrl");
    expect(modelKey("${KICAD10_3DMODEL_DIR}/Package_TO_SOT_SMD.3dshapes/SOT-23.step")).toBe("Package_TO_SOT_SMD.3dshapes/SOT-23.wrl");
    expect(modelKey("${KISYS3DMOD}/Capacitor_SMD.3dshapes/C_0603_1608Metric.wrl")).toBe("Capacitor_SMD.3dshapes/C_0603_1608Metric.wrl");
    expect(modelKey("${KIPRJMOD}/models/MyPart.step")).toBeUndefined();
    expect(modelKey("${KIPRJMOD}/lib/3dmodels/Button_Switch_SMD.3dshapes/SW.STEP")).toBeUndefined();
    expect(modelKey("../3d/custom.wrl")).toBeUndefined();
    expect(modelRawUrl("Resistor_SMD.3dshapes/R_0402_1005Metric.wrl")).toContain("KiCad/kicad-packages3D/master/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl");
  });
});

describe("parseVrml", () => {
  test("reads a real KiCad library model in millimetres", async () => {
    const mesh = parseVrml(await fixture("R_0402_1005Metric.wrl"));
    expect(mesh.triangles).toBeGreaterThan(50);
    expect(mesh.groups.length).toBeGreaterThanOrEqual(2); // body + pins
    const { min, max } = mesh.bounds;
    expect(max[0] - min[0]).toBeCloseTo(1.0, 0); // 1.0 mm long
    expect(max[1] - min[1]).toBeCloseTo(0.5, 0); // 0.5 mm wide
    expect(max[2] - min[2]).toBeLessThan(0.6); // 0.35..0.4 mm tall
    expect(min[2]).toBeGreaterThan(-0.05); // sits on the board
  });
  test("applies Transform translation and material reuse", () => {
    const wrl = `#VRML V2.0 utf8
Transform { translation 1 0 0 children [
  Shape { appearance Appearance { material DEF M Material { diffuseColor 1 0 0 } }
    geometry IndexedFaceSet { coord Coordinate { point [ 0 0 0, 1 0 0, 1 1 0, 0 1 0 ] } coordIndex [ 0 1 2 3 -1 ] } }
  Shape { appearance Appearance { material USE M }
    geometry IndexedFaceSet { coord Coordinate { point [ 0 0 1, 1 0 1, 1 1 1 ] } coordIndex [ 0, 1, 2, -1 ] } }
] }`;
    const mesh = parseVrml(wrl);
    expect(mesh.triangles).toBe(3);
    expect(mesh.groups).toHaveLength(1);
    expect(mesh.groups[0]!.color[0]).toBe(255);
    expect(mesh.bounds.min[0]).toBeCloseTo(2.54); // translated by 1 unit = 2.54 mm
    expect(mesh.bounds.max[2]).toBeCloseTo(2.54);
  });
  test("round-trips through the binary cache format", async () => {
    const mesh = parseVrml(await fixture("R_0402_1005Metric.wrl"));
    const back = decodeMesh(encodeMesh(mesh));
    expect(back.triangles).toBe(mesh.triangles);
    expect(back.groups.length).toBe(mesh.groups.length);
    expect(back.bounds).toEqual(mesh.bounds);
  });
});

describe("models in a board", () => {
  const board = `(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
    (footprint "R:R_0402" (layer "F.Cu") (at 10 10 90)
      (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
      (pad "1" smd rect (at -0.5 0 90) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
      (model "\${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))
    (footprint "R:R_0402" (layer "B.Cu") (at 30 10 0)
      (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "B.Fab"))
      (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "B.Cu" "B.Mask"))
      (model "\${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step"))
    (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`;
  test("collects model keys and places meshes on both sides", async () => {
    const b = parseBoard(board);
    expect(modelKeys(b)).toEqual(["Resistor_SMD.3dshapes/R_0402_1005Metric.wrl"]);
    const mesh = parseVrml(await fixture("R_0402_1005Metric.wrl"));
    const models = new Map([["Resistor_SMD.3dshapes/R_0402_1005Metric.wrl", mesh]]);
    const withModels = buildScene(b, { models });
    const boxes = buildScene(b);
    expect(withModels.mesh.count).toBeGreaterThan(boxes.mesh.count + 100);
    // front part sits above the board, back part below it
    expect(withModels.mesh.bounds.max[2]).toBeGreaterThan(0.8 + 0.3);
    expect(withModels.mesh.bounds.min[2]).toBeLessThan(-0.8 - 0.3);
    const img = renderMesh(withModels.mesh, VIEWS.angle, { width: 120, height: 90, supersample: 1 });
    expect(img.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });
  test("fetchModels uses the API first and falls back to the library", async () => {
    const wrl = await fixture("R_0402_1005Metric.wrl");
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/models/")) return new Response("", { status: 500 });
      if (url.includes("raw.githubusercontent.com")) return new Response(wrl);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const models = await fetchModels(["Resistor_SMD.3dshapes/R_0402_1005Metric.wrl", "bad key"], { fetch: fake, apiBase: "https://x/api/models" });
    expect(models.size).toBe(1);
    expect(calls[0]).toContain("/api/models/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl");
    expect(calls[1]).toContain("raw.githubusercontent.com");
  });
});

describe("project-local models", () => {
  test("resolves ${KIPRJMOD} paths against the zip and prefers the WRL twin of a STEP", async () => {
    const { zipSync } = await import("fflate");
    const { renderPcb, projectModelPath, joinProjectPath } = await import("../src/index");
    expect(projectModelPath("${KIPRJMOD}/models/Part.step")).toBe("models/Part.step");
    expect(projectModelPath("../lib/3d/x.wrl")).toBe("../lib/3d/x.wrl");
    expect(projectModelPath("${KICAD9_3DMODEL_DIR}/R.3dshapes/x.wrl")).toBeUndefined();
    expect(joinProjectPath("hw/rev2", "../lib/x.wrl")).toBe("hw/lib/x.wrl");
    const wrl = await fixture("R_0402_1005Metric.wrl");
    const board = `(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Custom:Part" (layer "F.Cu") (at 10 10 0)
        (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
        (model "\${KIPRJMOD}/models/Part.step"))
      (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`;
    const enc = new TextEncoder();
    const zip = zipSync({ "hw/board.kicad_pcb": enc.encode(board), "hw/models/Part.STEP": enc.encode("ISO-10303"), "hw/models/Part.wrl": enc.encode(wrl) });
    const offline = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const res = await renderPcb(zip, { views: ["top"], width: 64, height: 48, supersample: 1, png: false, fetchModels: { fetch: offline, apiBase: "" } });
    expect(res.board.modelsUsed).toBe(1);
    const noModels = await renderPcb(zip, { views: ["top"], width: 64, height: 48, supersample: 1, png: false, fetchModels: false });
    expect(noModels.board.modelsUsed).toBe(0);
  });
});

describe("STEP-only project models", () => {
  test("uses convertStep for STEP files and for vendored copies of missing library parts", async () => {
    const { zipSync } = await import("fflate");
    const { renderPcb, meshFromOcct } = await import("../src/index");
    const wrl = await fixture("R_0402_1005Metric.wrl");
    const stepMesh = parseVrml(wrl);
    const converted: string[] = [];
    const convertStep = async (bytes: Uint8Array) => {
      converted.push(new TextDecoder().decode(bytes));
      return stepMesh;
    };
    const board = `(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Custom:A" (layer "F.Cu") (at 10 10 0)
        (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
        (model "\${KIPRJMOD}/models/OnlyStep.step"))
      (footprint "Lib:B" (layer "F.Cu") (at 30 10 0)
        (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))
        (model "\${KICAD8_3DMODEL_DIR}/Connector_JST.3dshapes/NotInMirror.wrl"))
      (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`;
    const enc = new TextEncoder();
    const zip = zipSync({
      "board.kicad_pcb": enc.encode(board),
      "models/OnlyStep.step": enc.encode("STEP-A"),
      "lib/NotInMirror.STEP": enc.encode("STEP-B"),
    });
    const missing = (async () => new Response("", { status: 404, headers: { "x-pcb23d-model": "missing" } })) as unknown as typeof fetch;
    const res = await renderPcb(zip, { views: ["top"], width: 64, height: 48, supersample: 1, png: false, fetchModels: { fetch: missing, convertStep } });
    expect(res.board.modelsUsed).toBe(2);
    expect(converted.sort()).toEqual(["STEP-A", "STEP-B"]);
    // without a converter both stay boxes
    const boxes = await renderPcb(zip, { views: ["top"], width: 64, height: 48, supersample: 1, png: false, fetchModels: { fetch: missing } });
    expect(boxes.board.modelsUsed).toBe(0);
    // occt adapter: indexed triangles with a colour
    const mesh = meshFromOcct({
      success: true,
      meshes: [{ attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0] } }, index: { array: [0, 1, 2, 1, 3, 2] }, color: [1, 0.5, 0] }],
    });
    expect(mesh?.triangles).toBe(2);
    expect(mesh?.groups[0]?.color).toEqual([255, 127.5, 0]);
  });
});

import { describe, expect, test } from "bun:test";
import { lcscFromProperties, parseEasyedaComponent, parseEasyedaObj } from "../src/models/easyeda";
import { attachLcscModels } from "../src/models/lcsc";
import { encodeMesh } from "../src/models/mesh-format";
import { buildScene, parseBoard } from "../src/index";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));

const OBJ = `v 0 0 0
v 2 0 0
v 2 1 0
v 0 1 0
v 0 0 3
v 2 0 3
v 2 1 3
v 0 1 3
newmtl body
Kd 0.1 0.1 0.1
newmtl pin
Kd 0.9 0.8 0.3
usemtl body
f 1 2 3 4
f 5 6 7 8
usemtl pin
f 1 2 6 5
`;

describe("EasyEDA models", () => {
  test("finds LCSC numbers under the property names JLC tooling uses", () => {
    expect(lcscFromProperties({ LCSC: "C134092" })).toBe("C134092");
    expect(lcscFromProperties({ "LCSC Part": " c8545 " })).toBe("C8545");
    expect(lcscFromProperties({ "JLCPCB Part #": "C123456" })).toBe("C123456");
    expect(lcscFromProperties({ MPN: "C134092" })).toBeUndefined();
    expect(lcscFromProperties({ LCSC: "not-a-part" })).toBeUndefined();
  });
  test("reads the model uuid and placement from a components response", async () => {
    const info = parseEasyedaComponent(await fixture("easyeda-C134092.json").json(), "C134092");
    expect(info?.uuid).toBe("753ec1c05a40429c836855bddae44cbc");
    expect(info?.title).toBe("USB-C-SMD_TYPE-C-USB-18");
    expect(info?.rotate).toEqual([0, 0, 180]);
    expect(info?.offset[2]).toBeCloseTo(-1.0, 2); // z -3.937 canvas units × 0.254 mm
  });
  test("parses OBJ with inline materials, fan-triangulates, centres XY and puts the base at z=0", () => {
    const mesh = parseEasyedaObj(OBJ)!;
    expect(mesh.triangles).toBe(6);
    expect(mesh.groups.map((g) => g.color.map(Math.round))).toEqual([[26, 26, 26], [230, 204, 77]]);
    expect(mesh.bounds.min).toEqual([-1, -0.5, 0]);
    expect(mesh.bounds.max).toEqual([1, 0.5, 3]);
  });
  test("attaches LCSC models to model-less footprints through the API", async () => {
    const board = parseBoard(`(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "JLC:USB-C" (layer "F.Cu") (at 10 10 0)
        (property "LCSC" "C134092" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1))))
        (fp_rect (start -4 -3) (end 4 3) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
        (pad "1" smd rect (at -3 0) (size 1 1) (layers "F.Cu" "F.Mask")))
      (footprint "Lib:R" (layer "F.Cu") (at 30 10 0)
        (property "LCSC" "C999999" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1))))
        (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask")))
      (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (fill no)))`);
    expect(board.components[0]!.properties.LCSC).toBe("C134092");
    const mesh = parseEasyedaObj(OBJ)!;
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/lcsc/C134092"))
        return new Response(encodeMesh(mesh) as unknown as BodyInit, { headers: { "x-pcb23d-offset": "0.5,-0.25,-1", "x-pcb23d-rotate": "0,0,180", "x-pcb23d-title": "USB-C" } });
      if (url.endsWith("/api/lcsc/C999999")) return new Response("", { status: 404, headers: { "x-pcb23d-model": "missing" } });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const models = new Map();
    const attached = await attachLcscModels(board.components, models, { fetch: fake, lcscApiBase: "https://x/api/lcsc" });
    expect(attached).toBe(1);
    expect(models.has("lcsc:C134092")).toBe(true);
    const ref = board.components[0]!.models.find((m) => m.key === "lcsc:C134092")!;
    expect(ref.offset).toEqual([0.5, -0.25, -1]);
    expect(ref.rotate).toEqual([0, 0, 180]);
    const scene = buildScene(board, { models });
    // the USB-C box is replaced by the OBJ mesh: its pin colour appears as a material
    const colours = scene.mesh.materials.map((m) => (m.kind === "color" ? m.rgb.map(Math.round).join(",") : "tex"));
    expect(colours).toContain("230,204,77");
    expect(colours).toContain("26,26,26");
    expect(calls.filter((c) => c.includes("easyeda.com")).length).toBe(0);
  });
});

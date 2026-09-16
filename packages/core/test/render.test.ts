import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { encodePng, parseBackground, pickBoardPath, renderPcbSync, VIEWS } from "../src/index";
import { parseBoard } from "../src/kicad/board";
import { buildScene } from "../src/index";
import { renderMesh } from "../src/render";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("renderPcb", () => {
  test("renders a board text to PNGs for each requested view", async () => {
    const text = await fixture("constraints.kicad_pcb");
    const res = renderPcbSync(text, { views: ["top", "angle"], width: 160, height: 120, supersample: 1 });
    expect(Object.keys(res.images)).toEqual(["top", "angle"]);
    const top = res.images.top!;
    expect(top.width).toBe(160);
    expect(top.height).toBe(120);
    expect([...top.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // something opaque was drawn in the middle
    const mid = (60 * 160 + 80) * 4;
    expect(top.rgba.data[mid + 3]).toBeGreaterThan(200);
    // transparent corner
    expect(top.rgba.data[3]).toBe(0);
    expect(res.board.widthMm).toBeGreaterThan(0);
  });
  test("accepts a zip archive and picks the project board", async () => {
    const text = await fixture("ecc83-pp.kicad_pcb");
    const zip = zipSync({
      "proj/ecc83-pp.kicad_pro": new TextEncoder().encode("{}"),
      "proj/ecc83-pp.kicad_pcb": new TextEncoder().encode(text),
      "proj/ecc83-pp-backups/ecc83-pp-2024.kicad_pcb": new TextEncoder().encode(text),
      "__MACOSX/._junk.kicad_pcb": new Uint8Array([1, 2, 3]),
    });
    const res = renderPcbSync(zip, { views: ["top"], width: 64, height: 48, supersample: 1, png: false });
    expect(res.source.path).toBe("proj/ecc83-pp.kicad_pcb");
    expect(res.source.archivePaths.length).toBe(4);
    expect(res.images.top!.png.length).toBe(0);
  });
  test("errors clearly on archives without a board", () => {
    const zip = zipSync({ "readme.md": new TextEncoder().encode("hi") });
    expect(() => renderPcbSync(zip)).toThrow(/no \.kicad_pcb/);
  });
  test("background colour fills the frame", async () => {
    const text = await fixture("constraints.kicad_pcb");
    const res = renderPcbSync(text, { views: ["top"], width: 32, height: 32, supersample: 1, background: [10, 20, 30], png: false });
    const d = res.images.top!.rgba.data;
    expect(d[3]).toBe(255);
    expect(d[0]).toBe(10);
  });
  test("bottom view mirrors the top view", async () => {
    const board = parseBoard(await fixture("ecc83-pp.kicad_pcb"));
    const scene = buildScene(board, { components: false });
    const top = renderMesh(scene.mesh, VIEWS.top, { width: 64, height: 48, supersample: 1 });
    const bottom = renderMesh(scene.mesh, VIEWS.bottom, { width: 64, height: 48, supersample: 1 });
    // alpha (board silhouette) of the bottom view equals the horizontally mirrored top view
    let diff = 0;
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++) {
        const a = top.data[(y * 64 + x) * 4 + 3]!;
        const b = bottom.data[(y * 64 + (63 - x)) * 4 + 3]!;
        if (Math.abs(a - b) > 64) diff++;
      }
    expect(diff).toBeLessThan(64 * 48 * 0.02);
  });
});

describe("helpers", () => {
  test("pickBoardPath prefers the project's board over backups", () => {
    expect(pickBoardPath(["a/x-backups/x.kicad_pcb", "a/x.kicad_pcb", "a/x.kicad_pro"])).toBe("a/x.kicad_pcb");
    expect(pickBoardPath(["deep/er/b.kicad_pcb", "a.kicad_pcb"])).toBe("a.kicad_pcb");
    expect(pickBoardPath(["nothing.txt"])).toBeUndefined();
  });
  test("parseBackground", () => {
    expect(parseBackground(undefined)).toBe("transparent");
    expect(parseBackground("#102030")).toEqual([16, 32, 48]);
    expect(parseBackground("white")).toEqual([0xe9, 0xe9, 0xe4]);
  });
  test("encodePng produces a valid IHDR", () => {
    const png = encodePng({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]) });
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(2);
    expect(view.getUint32(20)).toBe(1);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
  });
});

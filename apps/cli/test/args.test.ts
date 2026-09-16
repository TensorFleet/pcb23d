import { describe, expect, test } from "bun:test";
import { parseArgs, parseViews } from "../src/args";

describe("parseArgs", () => {
  test("defaults", () => {
    const o = parseArgs(["board.zip"]);
    expect(o.inputs).toEqual(["board.zip"]);
    expect(o.views).toEqual(["top", "bottom", "angle"]);
    expect(o.width).toBe(1600);
    expect(o.components).toBe(true);
  });
  test("options in both spaced and = forms", () => {
    const o = parseArgs(["-o", "out", "--width=800", "-h", "600", "--mask", "black", "--no-components", "--json", "a.kicad_pcb"]);
    expect(o.out).toBe("out");
    expect(o.width).toBe(800);
    expect(o.height).toBe(600);
    expect(o.maskColor).toBe("black");
    expect(o.components).toBe(false);
    expect(o.json).toBe(true);
    expect(o.models).toBe(true);
    expect(parseArgs(["--no-models", "--models-url", "http://localhost:8787/api/models", "x"]).models).toBe(false);
    expect(parseArgs(["--no-step", "x"]).step).toBe(false);
    expect(parseArgs(["x"]).occtUrl).toContain("/occt");
  });
  test("rejects bad values", () => {
    expect(() => parseArgs(["--width", "abc", "x"])).toThrow(/--width/);
    expect(() => parseArgs(["--supersample", "9", "x"])).toThrow(/--supersample/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
  });
});

describe("parseViews", () => {
  test("named, all, and custom views", () => {
    expect(parseViews("top,angle")).toEqual(["top", "angle"]);
    expect(parseViews("all").length).toBeGreaterThan(3);
    expect(parseViews("hero=45/30/ortho")).toEqual([
      { name: "hero", azimuth: 45, elevation: 30, projection: "orthographic", fov: 28 },
    ]);
    expect(() => parseViews("sideways")).toThrow(/unknown view/);
  });
});

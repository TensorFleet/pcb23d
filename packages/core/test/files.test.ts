import { describe, expect, test } from "bun:test";
import { filesForOpen, kicadKind, pickMainDocument, shouldKeepPath } from "../src/kicad/files";

describe("kicadKind", () => {
  test("classifies design files", () => {
    expect(kicadKind("boards/hat.kicad_pcb")).toBe("board");
    expect(kicadKind("hat.kicad_pro")).toBe("project");
    expect(kicadKind("sym-lib-table")).toBe("library");
    expect(kicadKind("Adafruit Feather RP2040.brd")).toBe("board");
    expect(kicadKind("Adafruit Feather RP2040.sch")).toBe("schematic");
    expect(kicadKind("0.1/base/ferris.pro", ["0.1/base/ferris.pro", "0.1/base/ferris.kicad_pcb"])).toBe("project");
    expect(kicadKind("scripts/BusPirateGUI/BusPirateGUI.pro", ["scripts/BusPirateGUI/BusPirateGUI.pro"])).toBe("other");
  });
});

describe("shouldKeepPath", () => {
  test("drops git and node_modules", () => {
    expect(shouldKeepPath(".git/config", 10)).toBe(false);
    expect(shouldKeepPath("node_modules/foo/index.js", 10)).toBe(false);
    expect(shouldKeepPath("hat.kicad_pcb", 100)).toBe(true);
    expect(shouldKeepPath("Adafruit Feather RP2040.brd", 2_400_000)).toBe(true);
  });
});

describe("filesForOpen", () => {
  test("keeps the opened board and skips variants", () => {
    expect(
      filesForOpen(
        [
          "hat.kicad_pro",
          "hat.kicad_pcb",
          "hat.kicad_sch",
          "fp-lib-table",
          "lib/conn.kicad_mod",
          "variants/rev2/hat.kicad_pcb",
        ],
        "hat.kicad_pro",
      ),
    ).toEqual(["hat.kicad_pro", "hat.kicad_pcb", "hat.kicad_sch", "fp-lib-table"]);
  });
});

describe("pickMainDocument", () => {
  test("prefers a root project over a nested one", () => {
    expect(pickMainDocument(["gpio/breakout.kicad_pro", "hat.kicad_pcb", "hat.kicad_pro"])).toBe("hat.kicad_pro");
  });

  test("prefers the shorter Eagle board name at the same depth", () => {
    expect(
      pickMainDocument([
        "Adafruit Feather RP2040 Original.brd",
        "Adafruit Feather RP2040 rev B.brd",
        "Adafruit Feather RP2040.brd",
      ]),
    ).toBe("Adafruit Feather RP2040.brd");
  });
});

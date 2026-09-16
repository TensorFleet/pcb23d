import { describe, expect, test } from "bun:test";
import { atoms, child, children, flag, head, num, numbers, parseSExpr, str } from "../src/sexpr";

describe("parseSExpr", () => {
  test("parses nested lists, quoted strings and escapes", () => {
    const [root] = parseSExpr('(kicad_pcb (version 20241229) (net 1 "GND") (title "a \\"b\\" c"))');
    expect(head(root)).toBe("kicad_pcb");
    expect(num(root as never, "version")).toBe(20241229);
    expect(atoms(child(root as never, "net"))).toEqual(["1", "GND"]);
    expect(str(root as never, "title")).toBe('a "b" c');
  });
  test("handles unquoted legacy layer names and tabs/newlines", () => {
    const [root] = parseSExpr("(gr_line\n\t(start 1 2)\n\t(end 3 4)\n\t(layer Edge.Cuts)\n\t(width 0.1))");
    expect(str(root as never, "layer")).toBe("Edge.Cuts");
    expect(numbers(child(root as never, "start"))).toEqual([1, 2]);
    expect(children(root as never, "start")).toHaveLength(1);
  });
  test("flags accept (name yes) and bare atoms", () => {
    const [a] = parseSExpr("(pad (locked) (fill yes))");
    expect(flag(a as never, "locked")).toBe(true);
    expect(flag(a as never, "fill")).toBe(true);
    expect(flag(a as never, "hide")).toBe(false);
  });
  test("rejects unbalanced input", () => {
    expect(() => parseSExpr("(a (b)")).toThrow(SyntaxError);
    expect(() => parseSExpr("(a))")).toThrow(SyntaxError);
    expect(() => parseSExpr('(a "open')).toThrow(SyntaxError);
  });
});

import { describe, expect, test } from "bun:test";
import { fetchGithubBoard, isRemoteInput, parseGithubUrl } from "../src/github";

describe("parseGithubUrl", () => {
  test("repo, tree, blob, raw and shorthand forms", () => {
    expect(parseGithubUrl("https://github.com/TensorFleet/koyomi-lvds-hat")).toEqual({ owner: "TensorFleet", repo: "koyomi-lvds-hat" });
    expect(parseGithubUrl("github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubUrl("https://github.com/o/r/tree/main/hw")).toEqual({ owner: "o", repo: "r", ref: "main", path: "hw" });
    expect(parseGithubUrl("https://github.com/o/r/blob/v1.2/hw/board.kicad_pcb")).toEqual({ owner: "o", repo: "r", ref: "v1.2", path: "hw/board.kicad_pcb" });
    expect(parseGithubUrl("https://raw.githubusercontent.com/o/r/main/b.kicad_pcb")).toEqual({ owner: "o", repo: "r", ref: "main", path: "b.kicad_pcb" });
    expect(parseGithubUrl("o/r@dev/boards")).toEqual({ owner: "o", repo: "r", ref: "dev", path: "boards" });
    expect(parseGithubUrl("gh:o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubUrl("https://gitlab.com/o/r")).toBeNull();
    expect(parseGithubUrl("board.kicad_pcb")).toBeNull();
  });
  test("isRemoteInput", () => {
    expect(isRemoteInput("https://github.com/o/r")).toBe(true);
    expect(isRemoteInput("o/r")).toBe(true);
    expect(isRemoteInput("hw/board.kicad_pcb")).toBe(false);
    expect(isRemoteInput("./x.zip")).toBe(false);
  });
});

describe("fetchGithubBoard", () => {
  const files: Record<string, string> = {
    "README.md": "# hi",
    "hw/proj.kicad_pro": "{}",
    "hw/proj.kicad_pcb": "(kicad_pcb (version 1))",
    "hw/proj-backups/proj-old.kicad_pcb": "(kicad_pcb (version 0))",
  };
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/o/r") return Response.json({ default_branch: "trunk" });
    if (url.startsWith("https://api.github.com/repos/o/r/git/trees/trunk"))
      return Response.json({ truncated: false, tree: Object.keys(files).map((path) => ({ path, type: "blob" })) });
    const raw = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/trunk\/(.+)$/.exec(url);
    if (raw && files[decodeURIComponent(raw[1]!)]) return new Response(files[decodeURIComponent(raw[1]!)]!);
    if (url.includes("/repos/o/nope")) return new Response("", { status: 404 });
    if (url.includes("/repos/o/limited")) return new Response("", { status: 403 });
    return new Response("", { status: 500 });
  }) as typeof fetch;

  test("resolves the default branch, lists the tree, and picks the project board", async () => {
    const out = await fetchGithubBoard({ owner: "o", repo: "r" }, { fetch: fakeFetch });
    expect(out.path).toBe("hw/proj.kicad_pcb");
    expect(out.ref).toBe("trunk");
    expect(new TextDecoder().decode(out.bytes)).toContain("(kicad_pcb (version 1))");
    expect(out.archivePaths).toHaveLength(4);
  });
  test("direct file links skip the API", async () => {
    const out = await fetchGithubBoard({ owner: "o", repo: "r", ref: "trunk", path: "hw/proj.kicad_pcb" }, { fetch: fakeFetch });
    expect(out.url).toContain("raw.githubusercontent.com");
  });
  test("clear errors for missing repos and rate limits", async () => {
    await expect(fetchGithubBoard({ owner: "o", repo: "nope" }, { fetch: fakeFetch })).rejects.toThrow(/not found/);
    await expect(fetchGithubBoard({ owner: "o", repo: "limited" }, { fetch: fakeFetch })).rejects.toThrow(/rate limit/);
  });
});

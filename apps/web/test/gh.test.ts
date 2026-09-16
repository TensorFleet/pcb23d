import { describe, expect, test } from "bun:test";
import { fiddleClient, FiddleError, fiddlePath, formatImagePath, OG_RENDER, parseImagePath, renderObjectKey } from "../src/edge/gh";

describe("parseImagePath", () => {
  test("repo, ref, and image extension", () => {
    expect(parseImagePath("/img/gh/bob/nancy")).toEqual({ slug: { owner: "bob", repo: "nancy" }, format: null });
    expect(parseImagePath("/img/gh/bob/nancy/")).toEqual({ slug: { owner: "bob", repo: "nancy" }, format: null });
    expect(parseImagePath("/img/gh/bob/nancy.jpg")).toEqual({ slug: { owner: "bob", repo: "nancy" }, format: "jpg" });
    expect(parseImagePath("/img/gh/bob/nancy.JPEG")).toEqual({ slug: { owner: "bob", repo: "nancy" }, format: "jpg" });
    expect(parseImagePath("/img/gh/bob/nancy.png")).toEqual({ slug: { owner: "bob", repo: "nancy" }, format: "png" });
    expect(parseImagePath("/img/gh/bob/nancy/@v1.2.png")).toEqual({ slug: { owner: "bob", repo: "nancy", ref: "v1.2" }, format: "png" });
    expect(parseImagePath("/img/gh/bob/nancy/@feature/x.jpg")).toEqual({
      slug: { owner: "bob", repo: "nancy", ref: "feature/x" },
      format: "jpg",
    });
  });
  test("keeps dots in repo names that are not an extension", () => {
    expect(parseImagePath("/img/gh/bob/nancy.kicad")).toEqual({ slug: { owner: "bob", repo: "nancy.kicad" }, format: null });
  });
  test("rejects junk", () => {
    expect(parseImagePath("/img/gh/bob")).toBeNull();
    expect(parseImagePath("/img/gh/bob/nancy/extra")).toBeNull();
    expect(parseImagePath("/img/gh/bob/nancy/@../x")).toBeNull();
    expect(parseImagePath("/img/gh/-bob/nancy")).toBeNull();
    expect(parseImagePath("/img/gh/bob/%ZZ")).toBeNull();
    expect(parseImagePath("/img/gl/bob/nancy")).toBeNull();
  });
});

describe("paths and keys", () => {
  test("round-trips through formatImagePath", () => {
    const slug = { owner: "Bob", repo: "Nancy", ref: "feature/x" };
    expect(formatImagePath(slug)).toBe("/img/gh/Bob/Nancy/@feature/x");
    expect(formatImagePath(slug, "jpg")).toBe("/img/gh/Bob/Nancy/@feature/x.jpg");
    expect(parseImagePath(formatImagePath(slug, "png"))).toEqual({ slug, format: "png" });
    expect(fiddlePath(slug)).toBe("/gh/Bob/Nancy/@feature/x");
  });
  test("render keys sit under the pcbFiddle snapshot, lowercased", () => {
    expect(renderObjectKey("Bob", "Nancy", "a".repeat(40), OG_RENDER)).toBe(`gh/bob/nancy/${"a".repeat(40)}/renders/angle-1200x630-v1.jpg`);
  });
});

describe("fiddleClient", () => {
  const manifest = {
    owner: "bob",
    repo: "nancy",
    ref: "main",
    sha: "b".repeat(40),
    description: null,
    htmlUrl: "https://github.com/bob/nancy",
    files: [{ path: "hw/nancy.kicad_pcb", size: 12, url: `/api/gh/bob/nancy/@${"b".repeat(40)}/files/hw/nancy.kicad_pcb` }],
    openPath: "hw/nancy.kicad_pcb",
  };
  test("fetches the manifest and resolves relative file URLs against the origin", async () => {
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.endsWith("/api/gh/bob/nancy/@main")) return Response.json(manifest);
      if (url.includes("/files/hw/nancy.kicad_pcb")) return new Response("(kicad_pcb)");
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const client = fiddleClient("https://fiddle.test/", f);
    const got = await client.manifest({ owner: "bob", repo: "nancy", ref: "main" });
    expect(got.sha).toBe(manifest.sha);
    const bytes = await client.file(got, "hw/nancy.kicad_pcb");
    expect(new TextDecoder().decode(bytes)).toBe("(kicad_pcb)");
    expect(seen).toEqual([
      "https://fiddle.test/api/gh/bob/nancy/@main",
      `https://fiddle.test/api/gh/bob/nancy/@${"b".repeat(40)}/files/hw/nancy.kicad_pcb`,
    ]);
  });
  test("surfaces pcbFiddle's 404/422 and maps other failures to 502", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/missing")) return Response.json({ error: "repo not found" }, { status: 404 });
      if (url.includes("/empty")) return Response.json({ error: "no board" }, { status: 422 });
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const client = fiddleClient("https://fiddle.test", f);
    await expect(client.manifest({ owner: "bob", repo: "missing" })).rejects.toMatchObject({ status: 404, message: "repo not found" });
    await expect(client.manifest({ owner: "bob", repo: "empty" })).rejects.toMatchObject({ status: 422, message: "no board" });
    await expect(client.manifest({ owner: "bob", repo: "down" })).rejects.toBeInstanceOf(FiddleError);
    await expect(client.manifest({ owner: "bob", repo: "down" })).rejects.toMatchObject({ status: 502 });
  });
});

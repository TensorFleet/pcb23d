import { describe, expect, test } from "bun:test";
import {
  fiddleClient,
  FiddleError,
  fiddlePath,
  formatImagePath,
  OG_RENDER,
  parseImagePath,
  parsePickerInput,
  renderObjectKey,
  sourceUrl,
} from "../src/edge/gh";

describe("parseImagePath", () => {
  test("repo, ref, and image extension", () => {
    expect(parseImagePath("/img/gh/bob/nancy")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy" },
      format: null,
    });
    expect(parseImagePath("/img/gh/bob/nancy/")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy" },
      format: null,
    });
    expect(parseImagePath("/img/gh/bob/nancy.jpg")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy" },
      format: "jpg",
    });
    expect(parseImagePath("/img/gh/bob/nancy.JPEG")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy" },
      format: "jpg",
    });
    expect(parseImagePath("/img/gh/bob/nancy.png")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy" },
      format: "png",
    });
    expect(parseImagePath("/img/gh/bob/nancy/@v1.2.png")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy", ref: "v1.2" },
      format: "png",
    });
    expect(parseImagePath("/img/gh/bob/nancy/@feature/x.jpg")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy", ref: "feature/x" },
      format: "jpg",
    });
  });
  test("Codeberg and GitLab prefixes", () => {
    expect(parseImagePath("/img/cb/NollKollTroll/OpenSpand.jpg")).toEqual({
      slug: { kind: "cb", owner: "NollKollTroll", repo: "OpenSpand" },
      format: "jpg",
    });
    expect(parseImagePath("/img/gl/sixxie/dragon64/@master.png")).toEqual({
      slug: { kind: "gl", owner: "sixxie", repo: "dragon64", ref: "master" },
      format: "png",
    });
    expect(parseImagePath("/img/gl/my_group/board.jpg")).toEqual({
      slug: { kind: "gl", owner: "my_group", repo: "board" },
      format: "jpg",
    });
  });
  test("keeps dots in repo names that are not an extension", () => {
    expect(parseImagePath("/img/gh/bob/nancy.kicad")).toEqual({
      slug: { kind: "gh", owner: "bob", repo: "nancy.kicad" },
      format: null,
    });
  });
  test("rejects junk", () => {
    expect(parseImagePath("/img/gh/bob")).toBeNull();
    expect(parseImagePath("/img/gh/bob/nancy/extra")).toBeNull();
    expect(parseImagePath("/img/gh/bob/nancy/@../x")).toBeNull();
    expect(parseImagePath("/img/gh/-bob/nancy")).toBeNull();
    expect(parseImagePath("/img/gh/bob/%ZZ")).toBeNull();
    expect(parseImagePath("/img/bb/bob/nancy")).toBeNull();
  });
});

describe("paths and keys", () => {
  test("round-trips through formatImagePath", () => {
    const slug = { kind: "gh" as const, owner: "Bob", repo: "Nancy", ref: "feature/x" };
    expect(formatImagePath(slug)).toBe("/img/gh/Bob/Nancy/@feature/x");
    expect(formatImagePath(slug, "jpg")).toBe("/img/gh/Bob/Nancy/@feature/x.jpg");
    expect(parseImagePath(formatImagePath(slug, "png"))).toEqual({ slug, format: "png" });
    expect(fiddlePath(slug)).toBe("/gh/Bob/Nancy/@feature/x");
    expect(fiddlePath({ kind: "cb", owner: "NollKollTroll", repo: "OpenSpand" })).toBe(
      "/cb/NollKollTroll/OpenSpand",
    );
    expect(fiddlePath({ kind: "gl", owner: "sixxie", repo: "dragon64", ref: "master" })).toBe(
      "/gl/sixxie/dragon64/@master",
    );
  });
  test("render keys sit under the pcbFiddle snapshot, lowercased", () => {
    expect(renderObjectKey("Bob", "Nancy", "a".repeat(40), OG_RENDER)).toBe(
      `gh/bob/nancy/${"a".repeat(40)}/renders/angle-1200x630-v1.jpg`,
    );
    expect(renderObjectKey("NollKollTroll", "OpenSpand", "a".repeat(40), OG_RENDER, "cb")).toBe(
      `cb/nollkolltroll/openspand/${"a".repeat(40)}/renders/angle-1200x630-v1.jpg`,
    );
    expect(renderObjectKey("sixxie", "dragon64", "a".repeat(40), OG_RENDER, "gl")).toBe(
      `gl/sixxie/dragon64/${"a".repeat(40)}/renders/angle-1200x630-v1.jpg`,
    );
  });
  test("sourceUrl points at the forge page for the ref", () => {
    expect(sourceUrl({ owner: "bob", repo: "nancy", ref: "main" })).toBe(
      "https://github.com/bob/nancy/tree/main",
    );
    expect(sourceUrl({ kind: "cb", owner: "NollKollTroll", repo: "OpenSpand", ref: "main" })).toBe(
      "https://codeberg.org/NollKollTroll/OpenSpand/src/branch/main",
    );
    expect(sourceUrl({ kind: "gl", owner: "sixxie", repo: "dragon64", ref: "master" })).toBe(
      "https://gitlab.com/sixxie/dragon64/-/tree/master",
    );
    expect(sourceUrl({ kind: "cb", owner: "o", repo: "r", ref: "a".repeat(40) })).toBe(
      `https://codeberg.org/o/r/src/commit/${"a".repeat(40)}`,
    );
    expect(sourceUrl({ kind: "cb", owner: "o", repo: "r", ref: "v1.0", refKind: "tag" })).toBe(
      "https://codeberg.org/o/r/src/tag/v1.0",
    );
  });
});

describe("parsePickerInput", () => {
  test("GitHub shorthand, URLs, and already-canonical paths", () => {
    expect(parsePickerInput("bob/nancy")).toEqual({ kind: "gh", owner: "bob", repo: "nancy" });
    expect(parsePickerInput("https://github.com/bob/nancy/tree/main")).toEqual({
      kind: "gh",
      owner: "bob",
      repo: "nancy",
      ref: "main",
    });
    expect(parsePickerInput("github.com/acme/board/tree/feature/foo")).toEqual({
      kind: "gh",
      owner: "acme",
      repo: "board",
      ref: "feature/foo",
    });
    expect(parsePickerInput("img/gh/bob/nancy.jpg")).toEqual({
      kind: "gh",
      owner: "bob",
      repo: "nancy",
    });
    expect(parsePickerInput("https://github.com/acme/board.png")).toEqual({
      kind: "gh",
      owner: "acme",
      repo: "board.png",
    });
  });
  test("Codeberg and GitLab URLs", () => {
    expect(parsePickerInput("https://codeberg.org/NollKollTroll/OpenSpand")).toEqual({
      kind: "cb",
      owner: "NollKollTroll",
      repo: "OpenSpand",
    });
    expect(parsePickerInput("codeberg.org/NollKollTroll/OpenSpand/src/branch/main")).toEqual({
      kind: "cb",
      owner: "NollKollTroll",
      repo: "OpenSpand",
      ref: "main",
      refKind: "branch",
    });
    expect(parsePickerInput("codeberg.org/o/r/src/tag/v1.0")).toEqual({
      kind: "cb",
      owner: "o",
      repo: "r",
      ref: "v1.0",
      refKind: "tag",
    });
    expect(parsePickerInput("https://gitlab.com/sixxie/dragon64/-/tree/master")).toEqual({
      kind: "gl",
      owner: "sixxie",
      repo: "dragon64",
      ref: "master",
    });
    expect(parsePickerInput("gl/sixxie/dragon64")).toEqual({
      kind: "gl",
      owner: "sixxie",
      repo: "dragon64",
    });
  });
  test("rejects junk", () => {
    expect(parsePickerInput("")).toBeNull();
    expect(parsePickerInput("not a repo")).toBeNull();
    expect(parsePickerInput("https://bitbucket.org/bob/nancy")).toBeNull();
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
    files: [
      {
        path: "hw/nancy.kicad_pcb",
        size: 12,
        url: `/api/gh/bob/nancy/@${"b".repeat(40)}/files/hw/nancy.kicad_pcb`,
      },
    ],
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
  test("asks pcbFiddle under /api/cb and /api/gl", async () => {
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      return Response.json({ ...manifest, owner: "x", repo: "y" });
    }) as typeof fetch;
    const client = fiddleClient("https://fiddle.test", f);
    await client.manifest({ kind: "cb", owner: "NollKollTroll", repo: "OpenSpand" });
    await client.manifest({ kind: "gl", owner: "sixxie", repo: "dragon64", ref: "master" });
    expect(seen).toEqual([
      "https://fiddle.test/api/cb/NollKollTroll/OpenSpand",
      "https://fiddle.test/api/gl/sixxie/dragon64/@master",
    ]);
  });
  test("surfaces pcbFiddle's 404/422 and maps other failures to 502", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/missing"))
        return Response.json({ error: "repo not found" }, { status: 404 });
      if (url.includes("/empty")) return Response.json({ error: "no board" }, { status: 422 });
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const client = fiddleClient("https://fiddle.test", f);
    await expect(client.manifest({ owner: "bob", repo: "missing" })).rejects.toMatchObject({
      status: 404,
      message: "repo not found",
    });
    await expect(client.manifest({ owner: "bob", repo: "empty" })).rejects.toMatchObject({
      status: 422,
      message: "no board",
    });
    await expect(client.manifest({ owner: "bob", repo: "down" })).rejects.toBeInstanceOf(
      FiddleError,
    );
    await expect(client.manifest({ owner: "bob", repo: "down" })).rejects.toMatchObject({
      status: 502,
    });
  });
});

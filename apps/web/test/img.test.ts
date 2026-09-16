import { describe, expect, test } from "bun:test";
import { fillPage, renderBoardImage } from "../src/edge/img";
import { OG_RENDER } from "../src/edge/gh";

const template = `<!doctype html><html><head>
<title>Board render — PCB23D</title>
<meta name="description" content="x" />
<meta property="og:title" content="x" />
<meta property="og:description" content="x" />
<meta property="og:url" content="x" />
<meta property="og:image" content="x" />
<meta property="og:image:width" content="0" />
<meta property="og:image:height" content="0" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="x" />
<meta name="twitter:title" content="x" />
<meta name="twitter:description" content="x" />
<meta property="og:image:alt" content="x" />
<meta name="twitter:image:alt" content="x" />
<link rel="canonical" href="x" />
</head><body>
<section data-slot="render" hidden>
<h1 data-slot="repo">owner/repo</h1>
<img data-slot="image" alt="x" />
<a data-view="angle" href="#">Angle</a><a data-view="top" href="#">Top</a>
<a data-slot="download" href="#">dl</a>
<a data-slot="fiddle" href="#">fiddle</a>
<a data-slot="github" href="#">gh</a>
<code data-slot="page-url">x</code><code data-slot="image-url">x</code>
</section>
<section data-slot="picker">picker</section>
</body></html>`;

describe("fillPage", () => {
  test("points every slot and og tag at the repo's render", async () => {
    const res = fillPage(new Response(template, { headers: { "content-type": "text/html" } }), {
      origin: "https://pcbto3d.com",
      slug: { owner: "bob", repo: "nancy", ref: "main" },
      fiddleOrigin: "https://pcbfiddle.com",
    });
    const html = await res.text();
    expect(html).toContain("<title>bob/nancy@main — 3D render · PCB23D</title>");
    expect(html).toContain(
      '<meta property="og:image" content="https://pcbto3d.com/img/gh/bob/nancy/@main.jpg" />',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain(
      '<meta name="twitter:image" content="https://pcbto3d.com/img/gh/bob/nancy/@main.jpg" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://pcbto3d.com/img/gh/bob/nancy/@main" />',
    );
    expect(html).toContain(
      '<link rel="canonical" href="https://pcbto3d.com/img/gh/bob/nancy/@main" />',
    );
    expect(html).toContain(
      '<meta name="twitter:title" content="bob/nancy@main — 3D render · PCB23D" />',
    );
    expect(html).toContain(
      '<meta name="twitter:description" content="3D render of the bob/nancy KiCad board at main, drawn from the GitHub source." />',
    );
    expect(html).toContain(
      '<meta property="og:image:alt" content="3D render of the bob/nancy@main PCB" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image:alt" content="3D render of the bob/nancy@main PCB" />',
    );
    expect(html).toContain('<h1 data-slot="repo">bob/nancy@main</h1>');
    expect(html).toContain(
      '<img data-slot="image" alt="3D render of the bob/nancy@main PCB" src="https://pcbto3d.com/img/gh/bob/nancy/@main.jpg" />',
    );
    expect(html).toContain(
      '<a data-view="top" href="https://pcbto3d.com/img/gh/bob/nancy/@main.jpg?view=top">',
    );
    expect(html).toContain(
      '<a data-slot="fiddle" href="https://pcbfiddle.com/gh/bob/nancy/@main">',
    );
    expect(html).toContain('<a data-slot="github" href="https://github.com/bob/nancy/tree/main">');
    expect(html).toContain('<section data-slot="render">');
    expect(html).toContain('<section data-slot="picker" hidden="">');
  });
});

describe("renderBoardImage", () => {
  const fixture = Bun.file(
    new URL("../../../packages/core/test/fixtures/constraints.kicad_pcb", import.meta.url),
  );
  const ctx = { waitUntil() {} };
  test("encodes a JPEG social card without touching the network for a model-free board", async () => {
    const board = new Uint8Array(await fixture.arrayBuffer());
    const jpg = await renderBoardImage(
      board,
      "constraints.kicad_pcb",
      { ...OG_RENDER, width: 120, height: 63 },
      { ASSETS: { fetch: async () => new Response() } },
      ctx,
    );
    expect([...jpg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const png = await renderBoardImage(
      board,
      "constraints.kicad_pcb",
      { ...OG_RENDER, width: 120, height: 63, format: "png" },
      { ASSETS: { fetch: async () => new Response() } },
      ctx,
    );
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

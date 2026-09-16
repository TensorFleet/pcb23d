/** Copy the occt-import-js runtime into public/occt so the site can lazy-load it for STEP models. */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const here = new URL("..", import.meta.url).pathname;
const src = join(here, "node_modules/occt-import-js/dist");
const dst = join(here, "public/occt");
await mkdir(dst, { recursive: true });
for (const f of ["occt-import-js.js", "occt-import-js.wasm", "license.occt.txt", "license.occt-import-js.txt"]) {
  await copyFile(join(src, f), join(dst, f));
}
console.log("copied occt-import-js to public/occt");

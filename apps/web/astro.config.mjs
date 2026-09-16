import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

const core = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  output: "static",
  site: process.env.PUBLIC_SITE_URL ?? "https://pcb23d.com",
  build: { format: "directory" },
  vite: {
    resolve: { alias: [{ find: /^pcb23d$/, replacement: core }] },
    worker: { format: "es" },
  },
});

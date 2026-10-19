import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // The private @dtst/internal workspace is inlined; runtime dependencies stay external.
  noExternal: ["@dtst/internal"],
  define: { __DTST_VERSION__: JSON.stringify(version) },
});

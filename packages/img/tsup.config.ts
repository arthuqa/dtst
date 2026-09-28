import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  // Identity baked into the bundle so `--version` and MCP serverInfo work
  // without reading package.json at runtime.
  define: {
    __DTST_PACKAGE__: JSON.stringify(pkg.name),
    __DTST_VERSION__: JSON.stringify(pkg.version),
  },
  // The private @dtst/internal workspace is inlined into the published bundle.
  // `scripts/check-bundle.mjs` fails the build if that ever stops being true.
  noExternal: ["@dtst/internal"],
  external: ["@modelcontextprotocol/sdk", "openai", "zod", "dotenv", "tinyglobby"],
});

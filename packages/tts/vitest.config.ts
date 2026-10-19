import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dtst/internal": fileURLToPath(new URL("../internal/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 20_000 },
});

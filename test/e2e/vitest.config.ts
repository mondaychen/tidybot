import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:e2e`. Kept out of `pnpm test`: it needs Python packages and takes longer.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});

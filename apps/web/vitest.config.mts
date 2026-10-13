import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "paso-sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // The tests that reach testnet all send from one relayer account, so they run one file at a time.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});

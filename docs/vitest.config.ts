import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["plugins/**/*.spec.ts"],
    // The content specs parse every page of latest and of each archive.
    testTimeout: 30_000,
  },
});

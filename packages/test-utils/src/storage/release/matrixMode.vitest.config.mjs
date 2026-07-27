import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/test-utils/src/storage/release/matrixMode.spec.mjs"],
  },
});

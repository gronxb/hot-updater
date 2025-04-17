import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    globalSetup: ["./vitest.global-setup.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});

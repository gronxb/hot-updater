import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    include: ["**/*.spec.ts", "**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", ".ignored/**"],
    fileParallelism: false,
    globals: true,
    globalSetup: ["./vitest.global-setup.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    include: ["**/*.spec.ts", "**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", ".ignored/**"],
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

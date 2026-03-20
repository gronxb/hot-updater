import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    include: ["**/*.spec.ts", "**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", ".ignored/**"],
    // Disable file parallelism since we're running actual servers
    fileParallelism: false,
    // Run tests sequentially to avoid resource conflicts
    maxConcurrency: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

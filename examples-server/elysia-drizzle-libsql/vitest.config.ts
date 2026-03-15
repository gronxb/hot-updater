import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["dist/**"],
    // Disable file parallelism since we're running actual servers
    fileParallelism: false,
    // Run tests sequentially to avoid resource conflicts
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
  },
});

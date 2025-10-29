import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Disable file parallelism since we're running actual servers
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

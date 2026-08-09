import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["dist/**"],
    fileParallelism: false,
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["dist/**"],
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    maxWorkers: 1,
    pool: "forks",
  },
});

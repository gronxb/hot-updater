import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "plugin/src/**/*.spec.ts"],
    exclude: ["lib/**", "node_modules/**"],
  },
});

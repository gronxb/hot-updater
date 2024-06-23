import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: "@", replacement: resolve(__dirname, "./src") }],
  },
  test: {
    exclude: [
      "lib/**",
      "**/lib/**",
      "dist/**",
      "**/dist/**",
      "**/node_modules/**",
      "node_modules/**",
      "examples/**",
    ],
  },
});

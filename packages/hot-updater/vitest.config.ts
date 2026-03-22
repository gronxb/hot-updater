import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hot-updater/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@hot-updater/core/hotUpdateDirUtil": path.resolve(
        __dirname,
        "../core/src/hotUpdateDirUtil.ts",
      ),
    },
  },
});

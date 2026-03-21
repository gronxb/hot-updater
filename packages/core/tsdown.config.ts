import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/hotUpdateDirUtil.ts",
      "src/rollout.ts",
      "src/types.ts",
      "src/uuid.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    failOnWarn: true,
  },
]);

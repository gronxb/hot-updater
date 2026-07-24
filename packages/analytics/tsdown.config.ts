import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/legacy-server/index.ts",
      "src/provider/index.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: {
      customExports: {
        ".": {
          import: {
            types: "./dist/index.d.mts",
            default: "./dist/index.mjs",
          },
          require: {
            types: "./dist/index.d.cts",
            default: "./dist/index.cjs",
          },
        },
        "./legacy-server": {
          import: {
            types: "./dist/legacy-server/index.d.mts",
            default: "./dist/legacy-server/index.mjs",
          },
          require: {
            types: "./dist/legacy-server/index.d.cts",
            default: "./dist/legacy-server/index.cjs",
          },
        },
        "./provider": {
          import: {
            types: "./dist/provider/index.d.mts",
            default: "./dist/provider/index.mjs",
          },
          require: {
            types: "./dist/provider/index.d.cts",
            default: "./dist/provider/index.cjs",
          },
        },
      },
    },
    failOnWarn: true,
  },
]);

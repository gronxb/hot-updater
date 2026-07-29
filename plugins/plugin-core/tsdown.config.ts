import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/internal/capabilities.ts",
      "./src/internal/config-feature-manifest.ts",
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
        "./internal/capabilities": {
          import: {
            types: "./dist/internal/capabilities.d.mts",
            default: "./dist/internal/capabilities.mjs",
          },
          require: {
            types: "./dist/internal/capabilities.d.cts",
            default: "./dist/internal/capabilities.cjs",
          },
        },
        "./internal/config-feature-manifest": {
          import: {
            types: "./dist/internal/config-feature-manifest.d.mts",
            default: "./dist/internal/config-feature-manifest.mjs",
          },
          require: {
            types: "./dist/internal/config-feature-manifest.d.cts",
            default: "./dist/internal/config-feature-manifest.cjs",
          },
        },
      },
    },
    unbundle: true,
    failOnWarn: true,
  },
]);

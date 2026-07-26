import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/storage.ts",
      "./src/storage/node.ts",
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
        "./storage": {
          import: {
            types: "./dist/storage.d.mts",
            default: "./dist/storage.mjs",
          },
          require: {
            types: "./dist/storage.d.cts",
            default: "./dist/storage.cjs",
          },
        },
        "./storage/node": {
          import: {
            types: "./dist/storage/node.d.mts",
            default: "./dist/storage/node.mjs",
          },
          require: {
            types: "./dist/storage/node.d.cts",
            default: "./dist/storage/node.cjs",
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

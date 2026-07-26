import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/storage.ts", "src/storage/node.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    unbundle: true,
    deps: {
      neverBundle: [/^@hot-updater\/analytics(?:\/.*)?$/],
    },
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
      },
    },
    failOnWarn: true,
  },
]);

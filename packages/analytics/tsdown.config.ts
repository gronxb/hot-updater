import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/adapters/kysely.ts",
      "src/adapters/mongodb.ts",
      "src/internal/provider-capability.ts",
      "src/provider/index.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    deps: {
      neverBundle: [/^kysely(?:\/.*)?$/, /^mongodb(?:\/.*)?$/],
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
        "./adapters/kysely": {
          import: {
            types: "./dist/adapters/kysely.d.mts",
            default: "./dist/adapters/kysely.mjs",
          },
          require: {
            types: "./dist/adapters/kysely.d.cts",
            default: "./dist/adapters/kysely.cjs",
          },
        },
        "./adapters/mongodb": {
          import: {
            types: "./dist/adapters/mongodb.d.mts",
            default: "./dist/adapters/mongodb.mjs",
          },
          require: {
            types: "./dist/adapters/mongodb.d.cts",
            default: "./dist/adapters/mongodb.cjs",
          },
        },
        "./internal/provider-capability": {
          import: {
            types: "./dist/internal/provider-capability.d.mts",
            default: "./dist/internal/provider-capability.mjs",
          },
          require: {
            types: "./dist/internal/provider-capability.d.cts",
            default: "./dist/internal/provider-capability.cjs",
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

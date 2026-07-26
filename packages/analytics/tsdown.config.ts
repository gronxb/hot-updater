import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/internal/provider-capability.ts",
      "src/legacy-server/index.ts",
      "src/react-native/index.ts",
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
        "./react-native": {
          import: {
            types: "./dist/react-native/index.d.mts",
            default: "./dist/react-native/index.mjs",
          },
          require: {
            types: "./dist/react-native/index.d.cts",
            default: "./dist/react-native/index.cjs",
          },
        },
      },
    },
    failOnWarn: true,
  },
]);

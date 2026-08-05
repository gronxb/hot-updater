import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/managed.ts",
    "./src/managed/provisioning.ts",
  ],
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  unbundle: true,
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
      "./managed": {
        import: {
          types: "./dist/managed.d.mts",
          default: "./dist/managed.mjs",
        },
        require: {
          types: "./dist/managed.d.cts",
          default: "./dist/managed.cjs",
        },
      },
      "./managed/provisioning": {
        import: {
          types: "./dist/managed/provisioning.d.mts",
          default: "./dist/managed/provisioning.mjs",
        },
        require: {
          types: "./dist/managed/provisioning.d.cts",
          default: "./dist/managed/provisioning.cjs",
        },
      },
    },
  },
  failOnWarn: true,
});

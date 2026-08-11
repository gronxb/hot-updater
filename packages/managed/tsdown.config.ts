import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/deployment.ts"],
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
      "./deployment": {
        import: {
          types: "./dist/deployment.d.mts",
          default: "./dist/deployment.mjs",
        },
        require: {
          types: "./dist/deployment.d.cts",
          default: "./dist/deployment.cjs",
        },
      },
    },
  },
  failOnWarn: true,
});

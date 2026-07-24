import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
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
    },
  },
  failOnWarn: true,
});

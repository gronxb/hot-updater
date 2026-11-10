import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    // Writes package.json's exports and the inlinedDependencies field on every
    // build, so the field lists the versions dist/index.mjs actually bundles.
    exports: {
      customExports: {
        ".": {
          types: "./dist/index.d.mts",
          import: "./dist/index.mjs",
          require: "./dist/index.mjs",
        },
      },
      exclude: ["index"],
      inlinedDependencies: true,
      legacy: true,
    },
  },
]);

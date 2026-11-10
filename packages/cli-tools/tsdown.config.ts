import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    // tsdown writes exports and inlinedDependencies into package.json on every
    // build, so inlinedDependencies lists the versions dist actually bundles.
    exports: true,
  },
]);

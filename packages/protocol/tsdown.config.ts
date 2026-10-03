import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    // Zero dependencies: what protocol uses from verkit is bundled into dist.
    deps: {
      alwaysBundle: ["verkit"],
      onlyBundle: ["verkit"],
    },
    failOnWarn: true,
  },
]);

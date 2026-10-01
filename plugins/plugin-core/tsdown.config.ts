import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    deps: {
      alwaysBundle: ["verkit"],
      onlyBundle: ["verkit"],
    },
    unbundle: true,
    failOnWarn: true,
  },
]);

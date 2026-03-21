import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      config: "./src/config.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    shims: true,
  },
]);

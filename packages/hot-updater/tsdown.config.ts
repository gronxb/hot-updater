import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
    },
    format: ["esm"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    shims: true,
  },
  {
    entry: {
      config: "./src/config.ts",
    },
    format: ["esm"],
    outDir: "dist",
    dts: true,
    clean: false,
    failOnWarn: true,
    shims: true,
  },
]);

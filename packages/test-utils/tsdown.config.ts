import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    clean: true,
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["src/node.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    clean: false,
    dts: true,
    failOnWarn: true,
  },
]);

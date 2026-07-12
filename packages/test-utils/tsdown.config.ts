import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/node.ts"],
    format: ["esm"],
    outDir: "dist",
    dts: true,
    exports: true,
    failOnWarn: true,
  },
]);

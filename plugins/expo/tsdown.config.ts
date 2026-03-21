import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      "babel-plugin": "./src/babel.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    failOnWarn: true,
  },
]);

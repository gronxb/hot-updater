import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      config: "./src/config.ts",
      "plugins/babel": "./src/plugins/babel.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    shims: true,
  },
]);

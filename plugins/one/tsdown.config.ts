import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      // What a vite config imports for native.app.patches: it loads no CLI
      // tooling.
      patches: "./src/patches.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
  },
]);

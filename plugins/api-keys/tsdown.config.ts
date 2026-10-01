import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/server/index.ts"],
    // The output mirrors src/, so the package exports `./server`.
    root: "src",
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    unbundle: true,
    exports: {
      legacy: false,
      // tsdown exports a lone entry as the package root; this one is `./server`.
      customExports: ({ ".": server, ...rest }) => ({
        "./server": server,
        ...rest,
      }),
    },
    failOnWarn: true,
  },
]);

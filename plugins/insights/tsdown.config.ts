import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/server/index.ts",
      "./src/client/index.ts",
      "./src/internal.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    unbundle: true,
    exports: true,
    failOnWarn: true,
  },
]);

import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: {
      customExports: {
        ".": {
          import: "./dist/index.mjs",
          require: "./dist/index.cjs",
        },
        "./sql/analytics.sql": "./sql/analytics.sql",
      },
    },
    failOnWarn: true,
  },
]);

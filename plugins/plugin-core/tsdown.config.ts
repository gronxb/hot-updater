import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts", "./src/database-v2/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: {
      customExports: {
        "./database-v2": {
          import: {
            types: "./dist/database-v2/index.d.mts",
            default: "./dist/database-v2/index.mjs",
          },
          require: {
            types: "./dist/database-v2/index.d.cts",
            default: "./dist/database-v2/index.cjs",
          },
        },
      },
    },
    unbundle: true,
    failOnWarn: true,
  },
]);

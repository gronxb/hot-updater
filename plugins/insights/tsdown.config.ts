import { defineConfig } from "tsdown";

/** The Insights test suites import Vitest, which is ESM-only. */
const TESTING = "./testing";

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
    exports: {
      customExports: (exports) => ({
        ...exports,
        [TESTING]: {
          import: "./dist/server/testing/index.mjs",
        },
      }),
    },
    failOnWarn: true,
  },
  {
    entry: ["./src/server/testing/index.ts"],
    format: ["esm"],
    outDir: "dist/server/testing",
    clean: false,
    dts: true,
    unbundle: true,
    failOnWarn: true,
  },
]);

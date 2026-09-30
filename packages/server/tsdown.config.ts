import { defineConfig } from "tsdown";

/** The Insights plugin's tests import Vitest, which is ESM-only. */
const INSIGHTS_TESTING = "./plugins/insights/testing";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/node.ts",
      "./src/db/index.ts",
      "./src/diff.ts",
      "./src/internal.ts",
      "./src/database/index.ts",
      "./src/plugins/index.ts",
      "./src/plugins/insights/index.ts",
      "./src/plugins/api-keys/index.ts",
      "./src/adapters/kysely.ts",
      "./src/adapters/drizzle.ts",
      "./src/adapters/prisma.ts",
      "./src/adapters/mongodb.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    deps: {
      neverBundle: [
        /^bson(?:\/.*)?$/,
        /^drizzle-orm(?:\/.*)?$/,
        /^kysely(?:\/.*)?$/,
        /^mongodb(?:\/.*)?$/,
      ],
    },
    unbundle: true,
    exports: {
      customExports: (exports) => ({
        ...exports,
        [INSIGHTS_TESTING]: {
          import: "./dist/plugins/insights/testing/index.mjs",
        },
      }),
    },
    failOnWarn: true,
  },
  {
    entry: ["./src/plugins/insights/testing/index.ts"],
    format: ["esm"],
    outDir: "dist/plugins/insights/testing",
    clean: false,
    dts: true,
    unbundle: true,
    failOnWarn: true,
  },
]);

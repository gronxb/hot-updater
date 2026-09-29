import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/node.ts",
      "./src/db/index.ts",
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
    exports: true,
    failOnWarn: true,
  },
]);

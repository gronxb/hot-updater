import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/runtime.ts",
      "./src/capabilities.ts",
      "./src/node.ts",
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

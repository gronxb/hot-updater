import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/runtime.ts",
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
      alwaysBundle: (id) =>
        id.startsWith("fumadb") && !id.startsWith("fumadb/adapters/mongodb"),
      neverBundle: [
        /^bson(?:\/.*)?$/,
        /^kysely(?:\/.*)?$/,
        /^mongodb(?:\/.*)?$/,
      ],
    },
    unbundle: true,
    exports: true,
    failOnWarn: true,
  },
]);

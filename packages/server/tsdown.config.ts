import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/node.ts",
      "./src/db/index.ts",
      "./src/internal/first-party-plugin.ts",
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
      customExports: {
        ".": {
          import: {
            types: "./dist/index.d.mts",
            default: "./dist/index.mjs",
          },
          require: {
            types: "./dist/index.d.cts",
            default: "./dist/index.cjs",
          },
        },
        "./adapters/drizzle": {
          import: {
            types: "./dist/adapters/drizzle.d.mts",
            default: "./dist/adapters/drizzle.mjs",
          },
          require: {
            types: "./dist/adapters/drizzle.d.cts",
            default: "./dist/adapters/drizzle.cjs",
          },
        },
        "./adapters/kysely": {
          import: {
            types: "./dist/adapters/kysely.d.mts",
            default: "./dist/adapters/kysely.mjs",
          },
          require: {
            types: "./dist/adapters/kysely.d.cts",
            default: "./dist/adapters/kysely.cjs",
          },
        },
        "./adapters/mongodb": {
          import: {
            types: "./dist/adapters/mongodb.d.mts",
            default: "./dist/adapters/mongodb.mjs",
          },
          require: {
            types: "./dist/adapters/mongodb.d.cts",
            default: "./dist/adapters/mongodb.cjs",
          },
        },
        "./adapters/prisma": {
          import: {
            types: "./dist/adapters/prisma.d.mts",
            default: "./dist/adapters/prisma.mjs",
          },
          require: {
            types: "./dist/adapters/prisma.d.cts",
            default: "./dist/adapters/prisma.cjs",
          },
        },
        "./db": {
          import: {
            types: "./dist/db/index.d.mts",
            default: "./dist/db/index.mjs",
          },
          require: {
            types: "./dist/db/index.d.cts",
            default: "./dist/db/index.cjs",
          },
        },
        "./internal/first-party-plugin": {
          import: {
            types: "./dist/internal/first-party-plugin.d.mts",
            default: "./dist/internal/first-party-plugin.mjs",
          },
          require: {
            types: "./dist/internal/first-party-plugin.d.cts",
            default: "./dist/internal/first-party-plugin.cjs",
          },
        },
        "./node": {
          import: {
            types: "./dist/node.d.mts",
            default: "./dist/node.mjs",
          },
          require: {
            types: "./dist/node.d.cts",
            default: "./dist/node.cjs",
          },
        },
      },
    },
    failOnWarn: true,
  },
]);

import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/adapters/kysely.ts",
      "./src/adapters/drizzle.ts",
      "./src/adapters/prisma.ts",
      "./src/adapters/typeorm.ts",
      "./src/adapters/mongodb.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    unbundle: true,
    exports: true,
    failOnWarn: true,
  },
]);

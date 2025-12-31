import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/node.ts",
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
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
  },
]);

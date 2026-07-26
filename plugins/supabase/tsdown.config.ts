import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["src/edge/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist/edge",
    dts: true,
    failOnWarn: true,
  },
  {
    entry: [
      "src/storage/node.ts",
      "src/storage/edge.ts",
      "src/storage/unsupported.ts",
    ],
    format: ["esm", "cjs"],
    outDir: "dist/storage",
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    deps: {
      neverBundle: ["@hot-updater/supabase"],
    },
    failOnWarn: true,
  },
]);

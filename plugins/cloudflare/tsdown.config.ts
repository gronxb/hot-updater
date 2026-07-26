import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["src/worker/index.ts"],
    format: ["esm"],
    dts: true,
    outDir: "dist/worker",
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    failOnWarn: true,
  },
  {
    entry: ["src/storage/node.ts", "src/storage/unsupported.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/storage",
    failOnWarn: true,
  },
  {
    entry: ["src/storage/worker.ts"],
    format: ["esm"],
    dts: true,
    outDir: "dist/storage",
    failOnWarn: true,
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    deps: {
      neverBundle: ["@hot-updater/cloudflare"],
    },
    failOnWarn: true,
  },
]);

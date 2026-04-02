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
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/worker",
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

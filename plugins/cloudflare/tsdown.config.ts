import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/utils/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/cloudflare"],
    failOnWarn: true,
  },
]);

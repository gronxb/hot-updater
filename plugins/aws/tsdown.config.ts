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
    entry: ["lambda/index.ts"],
    format: ["cjs"],
    outDir: "dist/lambda",
    failOnWarn: true,
    noExternal: ["@hot-updater/server/runtime", "@hot-updater/plugin-core", "hono/lambda-edge", "hono"],
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/aws"],
    failOnWarn: true,
  },
]);

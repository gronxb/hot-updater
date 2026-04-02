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
    deps: {
      alwaysBundle: [
        "@hot-updater/server/runtime",
        "@hot-updater/plugin-core",
        "hono/lambda-edge",
        "hono",
      ],
    },
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    deps: {
      neverBundle: ["@hot-updater/aws"],
    },
    failOnWarn: true,
  },
]);

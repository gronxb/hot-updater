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
        "@hot-updater/server",
        "@hot-updater/server/plugins/api-keys",
        "@hot-updater/server/plugins/insights",
        "@hot-updater/plugin-core",
        "@hot-updater/plugin-api-keys/server",
        "@hot-updater/plugin-insights/server",
        "hono/lambda-edge",
        "hono",
      ],
    },
  },
  {
    // What `@hot-updater/aws` is when init bundles a project's server
    // definition into the managed Lambda@Edge function.
    entry: { managed: "lambda/managed.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: false,
    failOnWarn: true,
  },
  {
    entry: ["iac/init/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/init",
    failOnWarn: true,
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

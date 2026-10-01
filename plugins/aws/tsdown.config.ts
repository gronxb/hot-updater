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
    // `./init`: the provider's init, which `hot-updater init` imports once it
    // has installed this package.
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/init",
    deps: {
      neverBundle: ["@hot-updater/aws"],
    },
    failOnWarn: true,
  },
]);

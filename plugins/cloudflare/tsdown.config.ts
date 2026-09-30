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
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    failOnWarn: true,
  },
  {
    // What `@hot-updater/cloudflare` is when init bundles a project's server
    // definition into the managed Worker.
    entry: ["src/worker/managed.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist/worker",
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
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
      neverBundle: ["@hot-updater/cloudflare"],
    },
    failOnWarn: true,
  },
]);

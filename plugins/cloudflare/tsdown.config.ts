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
    // `./init`: the provider's init, which `hot-updater init` imports once it
    // has installed this package.
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/init",
    deps: {
      neverBundle: ["@hot-updater/cloudflare"],
    },
    failOnWarn: true,
  },
]);

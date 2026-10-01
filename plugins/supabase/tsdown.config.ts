import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/edge.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
  },
  {
    // What `@hot-updater/supabase` is when init bundles a project's server
    // definition into the managed Edge Function.
    entry: ["src/managed.ts"],
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
      neverBundle: ["@hot-updater/supabase"],
    },
    failOnWarn: true,
  },
]);

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
      neverBundle: ["@hot-updater/supabase"],
    },
    failOnWarn: true,
  },
]);

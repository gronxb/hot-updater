import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
  },
  {
    entry: ["firebase/functions/index.ts"],
    format: ["cjs"],
    dts: false,
    copy: {
      from: "firebase/public",
      to: "dist/firebase",
    },
    outDir: "dist/firebase/functions",
    deps: {
      neverBundle: ["firebase-functions", "firebase-admin"],
      alwaysBundle: [
        "@hot-updater/protocol",
        "@hot-updater/plugin-core",
        "@hot-updater/plugin-api-keys/server",
        "@hot-updater/plugin-insights/server",
        "@hot-updater/server",
        "@hot-updater/server/plugins/api-keys",
        "@hot-updater/server/plugins/insights",
      ],
    },
    failOnWarn: true,
  },
  {
    // `./init`: the provider's init, which `hot-updater init` imports once it
    // has installed this package.
    entry: ["iac/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist/init",
    deps: {
      neverBundle: ["@hot-updater/firebase"],
    },
    failOnWarn: true,
  },
]);

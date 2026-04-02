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
        "@hot-updater/core",
        "@hot-updater/js",
        "@hot-updater/plugin-core",
        "@hot-updater/server",
      ],
    },
    failOnWarn: true,
  },
  {
    entry: ["iac/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist/iac",
    deps: {
      neverBundle: ["@hot-updater/firebase"],
    },
    failOnWarn: true,
  },
]);

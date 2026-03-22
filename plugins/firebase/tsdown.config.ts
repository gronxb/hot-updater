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
    external: ["firebase-functions", "firebase-admin"],
    failOnWarn: true,
    noExternal: ["@hot-updater/core", "@hot-updater/js"],
  },
  {
    entry: ["iac/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/firebase"],
    failOnWarn: true,
  },
]);

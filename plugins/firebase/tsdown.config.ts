import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
  },
  {
    entry: ["firebase/functions/index.ts"],
    format: ["cjs"],
    publicDir: "firebase/public",
    outDir: "dist/firebase",
    external: ["firebase-functions", "firebase-admin"],
    noExternal: ["@hot-updater/core", "@hot-updater/js"],
  },
  {
    entry: ["iac/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/firebase"],
  },
]);

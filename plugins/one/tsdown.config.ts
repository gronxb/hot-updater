import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      // Bundles the private @hot-updater/config-plugin for app.plugin.js.
      "app.plugin": "./src/app.plugin.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    // The app provides these: One prebuild resolves expo/config-plugins, and
    // the plugin loads the app's hot-updater CLI for fingerprints.
    deps: {
      neverBundle: [/^expo(\/|$)/, /^@expo\//, /^hot-updater(\/|$)/],
    },
  },
]);

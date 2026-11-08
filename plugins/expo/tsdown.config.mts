import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      "babel-plugin": "./src/babel.ts",
      // Bundles the private @hot-updater/native-patches for app.plugin.js.
      "app.plugin": "./plugin/src/withHotUpdater.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    // app.plugin keeps the shape the tsc-built plugin had: `exports.default`
    // beside `getPublicKeyFromConfig`.
    outputOptions: { exports: "named" },
    // The app provides these: Expo prebuild resolves expo/config-plugins, and
    // the plugin loads the app's hot-updater CLI for fingerprints.
    deps: {
      neverBundle: [/^expo(\/|$)/, /^@expo\//, /^hot-updater(\/|$)/],
    },
  },
]);

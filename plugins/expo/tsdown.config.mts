import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/index.ts",
      "babel-plugin": "./src/babel.ts",
      // Bundles the private @hot-updater/config-plugin for app.plugin.js.
      "app.plugin": "./src/app.plugin.ts",
    },
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
    // The app provides these: Expo (or One) prebuild resolves
    // expo/config-plugins, and the plugin loads the app's hot-updater CLI.
    deps: {
      neverBundle: [/^expo(\/|$)/, /^@expo\//, /^hot-updater(\/|$)/],
    },
  },
]);

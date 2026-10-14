require("./hot-updater-build-config.cjs");
const path = require("path");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const appNodeModules = path.join(__dirname, "node_modules");
const symlinkResolver = MetroSymlinksResolver();

// Resolve React and React Native from this app, not from the workspace
// packages' own devDependencies.
const pinnedRuntimeModules = {
  react: path.join(appNodeModules, "react"),
  "react/jsx-dev-runtime": path.join(appNodeModules, "react/jsx-dev-runtime"),
  "react/jsx-runtime": path.join(appNodeModules, "react/jsx-runtime"),
  "react-native": path.join(appNodeModules, "react-native"),
};

module.exports = makeMetroConfig({
  resolver: {
    extraNodeModules: {
      react: pinnedRuntimeModules.react,
      "react-native": pinnedRuntimeModules["react-native"],
    },
    resolveRequest: (context, moduleName, platform) =>
      symlinkResolver(
        context,
        pinnedRuntimeModules[moduleName] ?? moduleName,
        platform,
      ),
  },
});

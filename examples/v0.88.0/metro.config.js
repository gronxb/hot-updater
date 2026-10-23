const path = require("path");
const { writeE2eBuildConfig } = require("@examples/e2e-app/build-config");
// makeMetroConfig watches the workspace packages the app depends on, this one
// included.
const { withE2eAppResolveRequest } = require("@examples/e2e-app/metro");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const appNodeModules = path.join(__dirname, "node_modules");
const symlinkResolver = MetroSymlinksResolver();

writeE2eBuildConfig(__dirname);

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
    resolveRequest: withE2eAppResolveRequest(
      (context, moduleName, platform) =>
        symlinkResolver(
          context,
          pinnedRuntimeModules[moduleName] ?? moduleName,
          platform,
        ),
      __dirname,
    ),
  },
});

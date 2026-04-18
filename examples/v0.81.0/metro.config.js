const path = require("path");
const {makeMetroConfig} = require('@rnx-kit/metro-config');
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const projectRoot = __dirname;
const appNodeModules = path.join(projectRoot, "node_modules");
const symlinkResolver = MetroSymlinksResolver();

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
    resolveRequest: (context, moduleName, platform) => {
      return symlinkResolver(
        context,
        pinnedRuntimeModules[moduleName] ?? moduleName,
        platform,
      );
    },
  },
});

const {writeE2eBuildConfig} = require("@examples/e2e-app/build-config");
const {
  E2E_APP_DIR,
  withE2eAppResolveRequest,
} = require("@examples/e2e-app/metro");
const path = require("path");
const {makeMetroConfig} = require('@rnx-kit/metro-config');
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const projectRoot = __dirname;
const appNodeModules = path.join(projectRoot, "node_modules");
const symlinkResolver = MetroSymlinksResolver();

writeE2eBuildConfig(projectRoot);

const pinnedRuntimeModules = {
  react: path.join(appNodeModules, "react"),
  "react/jsx-dev-runtime": path.join(appNodeModules, "react/jsx-dev-runtime"),
  "react/jsx-runtime": path.join(appNodeModules, "react/jsx-runtime"),
  "react-native": path.join(appNodeModules, "react-native"),
};

module.exports = makeMetroConfig({
  watchFolders: [E2E_APP_DIR],
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
      projectRoot,
    ),
  },
});

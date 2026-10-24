const path = require("node:path");

/** This package's directory, for the app's Metro watchFolders. */
const E2E_APP_DIR = __dirname;

/**
 * Wraps a Metro resolveRequest so this package's imports resolve as the
 * app's own: React Native, React Navigation, react-native-screens and the
 * SDK come from the app's node_modules, the versions its native code was
 * built with.
 */
function withE2eAppResolveRequest(resolveRequest, appDir) {
  const appOrigin = path.join(appDir, "index.js");
  return (context, moduleName, platform) =>
    context.originModulePath.startsWith(E2E_APP_DIR + path.sep) &&
    !moduleName.startsWith(".")
      ? resolveRequest(
          { ...context, originModulePath: appOrigin },
          moduleName,
          platform,
        )
      : resolveRequest(context, moduleName, platform);
}

module.exports = { E2E_APP_DIR, withE2eAppResolveRequest };

const path = require("node:path");

/**
 * Re.Pack resolve options for a target app: modules resolve from the app's
 * node_modules first, so this package's imports of React Native, React
 * Navigation, react-native-screens and the SDK get the app's copies, the
 * versions its native code was built with.
 */
function withE2eAppResolve(resolve, appDir) {
  return {
    ...resolve,
    modules: [
      path.join(appDir, "node_modules"),
      ...(resolve.modules ?? ["node_modules"]),
    ],
  };
}

module.exports = { withE2eAppResolve };

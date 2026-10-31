const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appEntry = path.join(__dirname, "index.ts");
const resolveRequest = config.resolver.resolveRequest;

// @hot-updater/react-native is a workspace symlink, so Metro resolves its
// imports from packages/react-native, whose dev copy of React isn't this app's.
// Two Reacts crash the first hook, so these always resolve from the app.
const isPinned = (moduleName) =>
  /^(react|react-native)(\/|$)/.test(moduleName);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const scoped = isPinned(moduleName)
    ? { ...context, originModulePath: appEntry }
    : context;
  return (resolveRequest ?? context.resolveRequest)(
    scoped,
    moduleName,
    platform,
  );
};

module.exports = config;

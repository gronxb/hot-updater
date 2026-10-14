const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// pnpm installs packages into the monorepo root's node_modules/.pnpm and
// symlinks them here, so Metro must also watch the monorepo root.
const monorepoRoot = path.resolve(__dirname, '../../..');

// Packages that must exist exactly once in the bundle. A dependency without
// its own copy (for example @callstack/react-native-brownfield, which has no
// react-native peer dependency) would otherwise resolve `react-native` through
// pnpm's hidden hoist directory, node_modules/.pnpm/node_modules, which holds
// whatever version another workspace package pulled in. Two React Native
// copies in one bundle break TurboModule lookups at startup.
const singletons = ['react', 'react-native'];
const projectEntry = path.join(__dirname, 'index.js');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      const singleton = singletons.some(
        (name) => moduleName === name || moduleName.startsWith(`${name}/`),
      );
      if (singleton) {
        // Resolve as if the import came from this project's entry file, so
        // Metro walks this project's node_modules first.
        return context.resolveRequest(
          { ...context, originModulePath: projectEntry },
          moduleName,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

// Writes src/hotUpdaterBuildConfig.js from the environment before Metro
// resolves App.tsx, for every bundle this project produces.
require('./hot-updater-build-config.cjs');

const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// pnpm installs packages into the monorepo root's node_modules/.pnpm and
// symlinks them here, so Metro must also watch the monorepo root.
const monorepoRoot = path.resolve(__dirname, '../../..');

// Packages always resolved from this project, wherever the import is.
// - `react` and `react-native` must exist exactly once in the bundle. A
//   dependency without its own copy (for example
//   @callstack/react-native-brownfield, which has no react-native peer
//   dependency) would otherwise resolve `react-native` through pnpm's hidden
//   hoist directory, node_modules/.pnpm/node_modules, which holds whatever
//   version another workspace package pulled in. Two React Native copies in
//   one bundle break TurboModule lookups at startup.
// - `@babel/runtime` helpers are imports Metro's Babel preset adds to every
//   file it transforms, including the workspace packages behind
//   @hot-updater/react-native, which have no copy of their own.
const projectModules = ['react', 'react-native', '@babel/runtime'];
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
      const fromProject = projectModules.some(
        name => moduleName === name || moduleName.startsWith(`${name}/`),
      );
      if (fromProject) {
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

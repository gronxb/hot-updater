const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// pnpm installs packages into the monorepo root's node_modules/.pnpm and
// symlinks them here, so Metro must also watch the monorepo root.
const monorepoRoot = path.resolve(__dirname, '../../..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [monorepoRoot],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

const path = require("node:path");
const { FileStore } = require("metro-cache");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const { getDefaultConfig } = require("expo/metro-config");
const MetroSymlinksResolver = require("@rnx-kit/metro-resolver-symlinks");

const projectDir = __dirname;
const workspaceRoot = path.resolve(projectDir, "../..");

const symlinksResolver = MetroSymlinksResolver();

/** @type {import('expo/metro-config').MetroConfig} */
const expoConfig = getDefaultConfig(projectDir);

/** @type {import('expo/metro-config').MetroConfig} */
module.exports = makeMetroConfig({
  ...expoConfig,
  resolver: {
    ...expoConfig.resolver,
    resolveRequest: (context, moduleName, platform) => {
      try {
        // Symlinks resolver throws when it can't find what we're looking for.
        const res = symlinksResolver(context, moduleName, platform);

        if (res) {
          return res;
        }
      } catch {
        // If we have an error, we pass it on to the next resolver in the chain,
        // which should be one of expos.
        // https://github.com/expo/expo/blob/9c025ce7c10b23546ca889f3905f4a46d65608a4/packages/%40expo/cli/src/start/server/metro/withMetroResolvers.ts#L47
        return context.resolveRequest(context, moduleName, platform);
      }
    },
  },
  watchFolders: [workspaceRoot],
  cacheStores: [
    new FileStore({
      root: path.join(projectDir, "node_modules", ".cache", "metro"),
    }),
  ],
});
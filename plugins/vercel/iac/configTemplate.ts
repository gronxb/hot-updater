import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ManagedPluginId,
  managedPluginsConfig,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

/** The config for `build`, listing `plugins`, the ones the Function runs: all by default. */
export const getConfigScaffold = (
  build: BuildType,
  plugins?: readonly ManagedPluginId[],
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["vercelBlobStorage"] }],
    configString: `vercelBlobStorage({
    token: process.env.HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN!,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["postgres"] }],
    configString: `postgres({
    connectionString: process.env.HOT_UPDATER_VERCEL_DATABASE_URL!,
  })`,
  };

  return createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuildType(build)
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      .setPlugins(managedPluginsConfig(plugins)),
  );
};

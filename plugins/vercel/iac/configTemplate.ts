import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export const getConfigScaffold = (
  build: BuildType,
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
      .setPlugins({
        imports: [
          {
            pkg: "hot-updater/plugins",
            named: ["apiKeys", "insights", "remoteConfig"],
          },
        ],
        configString: "[apiKeys(), insights(), remoteConfig()]",
      }),
  );
};

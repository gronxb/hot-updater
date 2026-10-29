import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

/**
 * The config init and the agent scaffold write: the Blob token and the
 * database URL are read with `secret()`, from the environment and
 * `.env.hotupdater`, then the config's `secrets` adapter.
 */
export const getConfigScaffold = (
  build: BuildType,
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["vercelBlobStorage"] }],
    configString: `vercelBlobStorage({
    token: secret("HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN"),
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["postgres"] }],
    configString: `postgres({
    connectionString: secret("HOT_UPDATER_VERCEL_DATABASE_URL"),
  })`,
  };
  const builder = new ConfigBuilder()
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
    })
    .addImport({ pkg: "hot-updater", named: ["secret"] });

  return createHotUpdaterConfigScaffoldFromBuilder(builder);
};

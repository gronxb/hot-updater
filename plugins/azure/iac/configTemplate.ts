import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

/**
 * The container init creates, `AZURE_BLOB_V1_CONTAINER`. The scaffold build
 * loads this file with Node's type stripping, which resolves no relative
 * import without its extension, so it names the container itself.
 */
const BLOB_CONTAINER = "hot-updater";

export const getConfigScaffold = (
  build: BuildType,
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/azure", named: ["azureBlobStorage"] }],
    configString: `azureBlobStorage({
    connectionString: process.env.HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING!,
    containerName: "${BLOB_CONTAINER}",
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/azure", named: ["cosmosDatabase"] }],
    configString: `cosmosDatabase({
    connectionString: process.env.HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING!,
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

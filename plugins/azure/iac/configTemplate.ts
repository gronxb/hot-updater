import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  secretEnvHelper,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

/**
 * The container init creates, `AZURE_BLOB_V1_CONTAINER`. The scaffold build
 * loads this file with Node's type stripping, which resolves no relative
 * import without its extension, so it names the container itself.
 */
const BLOB_CONTAINER = "hot-updater";

/** The Cosmos DB account init set up, which the config names as it is. */
export interface AzureConfigResources {
  /** The account's endpoint, such as `https://<account>.documents.azure.com:443/`. */
  readonly cosmosEndpoint?: string;
}

/**
 * The config init writes. With the `resources` init set up, it names the
 * Cosmos DB account, and reads both connection strings with `secretEnv`,
 * from the environment and `.env.hotupdater`, then the config's `secrets`
 * adapter. Without them, as the agent scaffold writes it, it reads them
 * from the environment.
 */
export const getConfigScaffold = (
  build: BuildType,
  resources?: AzureConfigResources,
): HotUpdaterConfigScaffold => {
  const read = (reader: string, name: string) =>
    resources === undefined
      ? `process.env.${name}!`
      : `async () =>
      (await ${reader}()).${name}`;
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/azure", named: ["azureBlobStorage"] }],
    configString: `azureBlobStorage({
    connectionString: ${read("storageSecrets", "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING")},
    containerName: "${BLOB_CONTAINER}",
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/azure", named: ["cosmosDatabase"] }],
    configString: `cosmosDatabase({${
      resources?.cosmosEndpoint === undefined
        ? ""
        : `
    endpoint: ${JSON.stringify(resources.cosmosEndpoint)},`
    }
    connectionString: ${read("databaseSecrets", "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING")},
  })`,
  };
  const helperStatements =
    resources === undefined
      ? []
      : [
          secretEnvHelper("storageSecrets", [
            "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
          ]),
          secretEnvHelper("databaseSecrets", [
            "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
          ]),
        ];

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
    });
  if (resources !== undefined) {
    builder
      .addImport({ pkg: "hot-updater", named: ["secretEnv"] })
      .setIntermediateCode(
        helperStatements.map(({ code }) => code).join("\n\n"),
      );
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};

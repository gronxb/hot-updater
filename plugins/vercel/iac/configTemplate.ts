import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export interface VercelConfigOptions {
  /**
   * Whether the config reads the Blob token and the database URL with
   * `secret()`, from the environment and `.env.hotupdater`, then the
   * config's `secrets` adapter, as init writes it. Without it, as the agent
   * scaffold writes it, it reads them from the environment.
   */
  readonly secrets: boolean;
}

export const getConfigScaffold = (
  build: BuildType,
  { secrets }: VercelConfigOptions = { secrets: false },
): HotUpdaterConfigScaffold => {
  const read = (name: string) =>
    secrets ? `secret("${name}")` : `process.env.${name}!`;
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["vercelBlobStorage"] }],
    configString: `vercelBlobStorage({
    token: ${read("HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN")},
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/vercel", named: ["postgres"] }],
    configString: `postgres({
    connectionString: ${read("HOT_UPDATER_VERCEL_DATABASE_URL")},
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
    });
  if (secrets) {
    builder.addImport({ pkg: "hot-updater", named: ["secret"] });
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder);
};

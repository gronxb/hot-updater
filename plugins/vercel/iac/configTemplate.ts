import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  deploySecretsHelper,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export interface VercelConfigOptions {
  /**
   * Whether the config reads the Blob token and the database URL with
   * `secretEnv`, from the environment and `.env.hotupdater`, then the
   * config's `secrets` adapter, as init writes it. Without it, as the agent
   * scaffold writes it, it reads them from the environment.
   */
  readonly secretEnv: boolean;
}

export const getConfigScaffold = (
  build: BuildType,
  { secretEnv }: VercelConfigOptions = { secretEnv: false },
): HotUpdaterConfigScaffold => {
  const read = (name: string) =>
    secretEnv
      ? `async () =>
      (await deploySecrets()).${name}`
      : `process.env.${name}!`;
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
  const helperStatements = secretEnv
    ? [
        deploySecretsHelper([
          "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
          "HOT_UPDATER_VERCEL_DATABASE_URL",
        ]),
      ]
    : [];

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
  if (secretEnv) {
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

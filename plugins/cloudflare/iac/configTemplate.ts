import {
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
  type RunInitOptions,
} from "@hot-updater/cli-tools";

/** The Cloudflare resources init set up, which the config names as they are. */
export interface CloudflareConfigResources {
  readonly accountId: string;
  readonly bucketName: string;
  readonly d1DatabaseId: string;
}

/**
 * The config init writes. With the `resources` init set up, it names them,
 * and reads the API token and R2 keys with `secret()`, from the
 * environment and `.env.hotupdater`, then the config's `secrets` adapter.
 * Without them, as the agent scaffold writes it before the agent creates the
 * resources, it reads their IDs from the environment, where the agent
 * records them, and the credentials with `secret()` alike.
 */
export const getConfigScaffold = (
  build: RunInitOptions["build"],
  resources?: CloudflareConfigResources,
): HotUpdaterConfigScaffold => {
  const builder = new ConfigBuilder().setBuildType(build).setPlugins({
    imports: [
      {
        pkg: "hot-updater/plugins",
        named: ["apiKeys", "insights", "remoteConfig"],
      },
    ],
    configString: "[apiKeys(), insights(), remoteConfig()]",
  });

  if (resources === undefined) {
    return createHotUpdaterConfigScaffoldFromBuilder(
      builder
        .setStorage({
          imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
          configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  })`,
        })
        .setDatabase({
          imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
          configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
  })`,
        })
        .addImport({ pkg: "hot-updater", named: ["secret"] }),
    );
  }

  const accountId = JSON.stringify(resources.accountId);
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
    configString: `r2Storage({
    bucketName: ${JSON.stringify(resources.bucketName)},
    accountId: ${accountId},
    credentials: {
      accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
    configString: `d1Database({
    databaseId: ${JSON.stringify(resources.d1DatabaseId)},
    accountId: ${accountId},
    cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
  })`,
  };

  return createHotUpdaterConfigScaffoldFromBuilder(
    builder
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      .addImport({ pkg: "hot-updater", named: ["secret"] }),
  );
};

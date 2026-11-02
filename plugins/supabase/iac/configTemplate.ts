import {
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
  type BuildType,
} from "@hot-updater/cli-tools";

/** The Supabase project and bucket init set up, which the config names as they are. */
export interface SupabaseConfigResources {
  readonly supabaseUrl: string;
  readonly bucketName: string;
}

/**
 * The config init writes. With the `resources` init set up, it names them,
 * and reads the service role key with `secret()`, from the environment and
 * `.env.hotupdater`, then the config's `secrets` adapter. Without them, as
 * the agent scaffold writes it before the agent creates the project, it
 * reads the URL and bucket from the environment, where the agent records
 * them, and the key with `secret()` alike.
 */
export const getConfigScaffold = (
  build: BuildType,
  resources?: SupabaseConfigResources,
): HotUpdaterConfigScaffold => {
  const supabaseUrl =
    resources === undefined
      ? "process.env.HOT_UPDATER_SUPABASE_URL!"
      : JSON.stringify(resources.supabaseUrl);
  const serviceRoleKey = 'secret("HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY")';
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
    configString: `supabaseStorage({
    supabaseUrl: ${supabaseUrl},
    supabaseServiceRoleKey: ${serviceRoleKey},
    bucketName: ${
      resources === undefined
        ? "process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!"
        : JSON.stringify(resources.bucketName)
    },
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
    configString: `supabaseDatabase({
    supabaseUrl: ${supabaseUrl},
    supabaseServiceRoleKey: ${serviceRoleKey},
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
  builder.addImport({ pkg: "hot-updater", named: ["secret"] });

  return createHotUpdaterConfigScaffoldFromBuilder(builder);
};

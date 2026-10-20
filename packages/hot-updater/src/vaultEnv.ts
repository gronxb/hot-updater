import {
  createVaultClient,
  getCwd,
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
  readVaultConnection,
  resolveVaultVariables,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
} from "@hot-updater/cli-tools";

/**
 * The client the connection variables set, in the environment or `env`
 * (`.env.hotupdater`'s by default), or an error naming what is missing.
 */
export const connectVault = async (
  wanted: string,
  env?: Readonly<Record<string, string>>,
): Promise<VaultClient> => {
  const read = readVaultConnection(
    env ?? (await readLoadedHotUpdaterEnv(getCwd())),
  );
  if (!read.ok) {
    throw new Error(
      `${wanted} from the Console's vault, and ${read.missing.join(" and ")} ${read.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} to reach the vault.`,
    );
  }
  return createVaultClient(read.connection);
};

/**
 * Environment variables from the Console's vault, as a function a config
 * calls when it needs them, so loading `hot-updater.config.ts` stays
 * synchronous and only that call reaches for them. Each name set in the environment
 * (`process.env`, which a config's dotenv fills) wins and never reaches the
 * vault; the others come from the `deploy-credentials` and `generic` secrets
 * the vault token reaches, over `HOT_UPDATER_CONSOLE_URL` and
 * `HOT_UPDATER_VAULT_TOKEN`. Each call reaches the Console again: nothing is
 * cached. Values are masked in the CLI's logs.
 *
 * @example
 * const deploy = vaultEnv(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
 * s3Storage({
 *   bucketName: "bundles",
 *   region: "us-east-1",
 *   credentials: async () => {
 *     const env = await deploy();
 *     return {
 *       accessKeyId: env.S3_ACCESS_KEY_ID,
 *       secretAccessKey: env.S3_SECRET_ACCESS_KEY,
 *     };
 *   },
 * });
 */
export const vaultEnv = <const TName extends string>(
  names: readonly TName[],
): (() => Promise<Readonly<Record<TName, string>>>) => {
  const wanted = [...new Set(names)];
  return async () => {
    const variables: Record<string, string> = {};
    const fromVault: string[] = [];
    for (const name of wanted) {
      const value = getHotUpdaterEnvValue({}, name);
      if (value === undefined) fromVault.push(name);
      else variables[name] = value;
    }
    if (fromVault.length > 0) {
      let client: VaultClient;
      try {
        client = await connectVault(
          `vaultEnv resolves ${fromVault.join(", ")}`,
        );
      } catch (error) {
        throw new Error(
          `${(error as Error).message} Or set ${fromVault.join(", ")} in the environment.`,
        );
      }
      Object.assign(
        variables,
        await resolveVaultVariables(client, { names: fromVault }),
      );
    }
    return Object.freeze(variables) as Readonly<Record<TName, string>>;
  };
};

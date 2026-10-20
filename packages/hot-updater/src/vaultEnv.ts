import {
  createVaultClient,
  getHotUpdaterEnvValue,
  readVaultConnection,
  registerSecretValue,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  type VaultSecretMetadata,
} from "@hot-updater/cli-tools";

/** The kinds whose values are environment variables, by name. */
const VARIABLE_KINDS: readonly string[] = ["deploy-credentials", "generic"];

/** The variables a key/value secret's metadata lists, as the Console derives them. */
const variablesOf = (secret: VaultSecretMetadata): readonly string[] => {
  const { variables } = secret.metadata;
  return Array.isArray(variables)
    ? variables.filter((name): name is string => typeof name === "string")
    : [];
};

const quoted = (names: readonly string[]) =>
  names.map((name) => `"${name}"`).join(", ");

/** The client the connection variables set, or an error naming what is missing. */
export const connectVault = (wanted: string): VaultClient => {
  const read = readVaultConnection();
  if (!read.ok) {
    throw new Error(
      `${wanted} from the Console's vault, and ${read.missing.join(" and ")} ${read.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} to reach the vault.`,
    );
  }
  return createVaultClient(read.connection);
};

/**
 * The variables of the vault's `deploy-credentials` and `generic` secrets
 * that the token reaches: those `names` lists, or every one. A secret
 * lists its variables in its metadata, which the Console derives when it
 * stores the secret, and resolving those secrets is one more request. Each
 * value is masked in logs. A variable two secrets set is refused, naming
 * both.
 */
export const resolveVaultVariables = async (
  client: VaultClient,
  names?: readonly string[],
): Promise<Record<string, string>> => {
  const secrets = (await client.list()).filter((secret) =>
    VARIABLE_KINDS.includes(secret.kind),
  );
  const holders = new Map<string, string[]>();
  for (const secret of secrets) {
    for (const variable of variablesOf(secret)) {
      holders.set(variable, [...(holders.get(variable) ?? []), secret.name]);
    }
  }
  const wanted = names ?? [...holders.keys()];
  const missing = wanted.filter((name) => !holders.has(name));
  if (missing.length > 0) {
    throw new Error(
      `No deploy-credentials or generic secret the vault token reaches at ${client.url} sets ${missing.join(", ")}. Store ${missing.length === 1 ? "it" : "them"} with hot-updater secrets put, or set ${missing.length === 1 ? "it" : "them"} in the environment.`,
    );
  }
  for (const name of wanted) {
    const from = holders.get(name)!;
    if (from.length > 1) {
      throw new Error(
        `${name} is set by the vault's secrets ${quoted(from)}: keep it in one of them.`,
      );
    }
  }
  const secretNames = [
    ...new Set(wanted.map((name) => holders.get(name)![0]!)),
  ];
  if (secretNames.length === 0) return {};

  const { secrets: resolved } = await client.resolve(secretNames);
  const values = new Map(
    resolved.map((secret) => [
      secret.name,
      (typeof secret.value === "object" && secret.value !== null
        ? secret.value
        : {}) as Record<string, unknown>,
    ]),
  );
  const variables: Record<string, string> = {};
  for (const name of wanted) {
    const secretName = holders.get(name)![0]!;
    const value = values.get(secretName)?.[name];
    if (typeof value !== "string") {
      throw new Error(
        `The vault's ${secretName} lists ${name} but holds no value for it: store it again with hot-updater secrets put.`,
      );
    }
    registerSecretValue(value);
    variables[name] = value;
  }
  return variables;
};

/**
 * Environment variables from the Console's vault, as a function a config
 * calls when it needs them, so loading `hot-updater.config.ts` stays
 * synchronous and reaches no network. Each name set in the environment
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
        client = connectVault(`vaultEnv resolves ${fromVault.join(", ")}`);
      } catch (error) {
        throw new Error(
          `${(error as Error).message} Or set ${fromVault.join(", ")} in the environment.`,
        );
      }
      Object.assign(variables, await resolveVaultVariables(client, fromVault));
    }
    return Object.freeze(variables) as Readonly<Record<TName, string>>;
  };
};

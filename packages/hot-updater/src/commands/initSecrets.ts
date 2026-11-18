import {
  configSetsTeamSecrets,
  InitError,
  type InitProviderDefinition,
  loadTeamSecrets,
  MANAGED_CLIENT_CREDENTIAL_ENV,
  p,
  readMissingFromTeamSecrets,
  StoredSecretsConflictError,
  storeEnvFileSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The team secrets store an init run reads from and stores in. */
export interface InitTeamSecrets {
  readonly adapter: SecretsAdapter;
  /** The provider's credentials and the app's API key. */
  readonly names: readonly string[];
  /** The ones the environment and the env files lack, from the adapter. */
  readonly secretsEnv: Readonly<Record<string, string>>;
}

/**
 * The config's team `secrets` adapter, when it sets one, with the
 * provider's credentials `env` (the environment and init's env files) lacks
 * read from it in one call. Undefined with `localSecrets()`, and when a
 * config that sets no team store can't load, which init says; a config
 * that sets one and can't load stops init.
 */
export const openInitTeamSecrets = async ({
  provider,
  env,
  cwd,
}: {
  readonly provider: InitProviderDefinition;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}): Promise<InitTeamSecrets | undefined> => {
  let adapter: SecretsAdapter | undefined;
  try {
    adapter = await loadTeamSecrets();
  } catch (error) {
    // A store the config sets but init can't read may hold the credentials
    // init would otherwise ask for or create again.
    if (await configSetsTeamSecrets(cwd)) {
      throw new InitError(
        [
          "hot-updater.config.ts sets a secrets adapter, but doesn't load:",
          message(error),
          "Fix it, then run init again.",
        ].join("\n"),
      );
    }
    p.log.warn(
      [
        "Couldn't load hot-updater.config.ts for its secrets adapter.",
        message(error),
        "Credentials stay in .env.hotupdater.",
      ].join("\n"),
    );
    return undefined;
  }
  if (adapter === undefined) return undefined;
  const names = [...(provider.secrets ?? []), MANAGED_CLIENT_CREDENTIAL_ENV];
  let secretsEnv: Readonly<Record<string, string>>;
  try {
    secretsEnv = await readMissingFromTeamSecrets(adapter, names, {
      env,
      cwd,
    });
  } catch (error) {
    // It names the secrets and the adapter already.
    throw new InitError(message(error));
  }
  return { adapter, names, secretsEnv };
};

/**
 * Stores the credentials init saved in `.env.hotupdater` through the team
 * adapter and reads them back. It deletes nothing: the app's build reads
 * `HOT_UPDATER_API_KEY` from the file, and its lines override the adapter
 * on this machine. A failure leaves everything as init wrote it, and says
 * why, such as a store that does not read back what it was given.
 *
 * Another value the adapter holds may be its only copy, as `secrets import`
 * refuses it: nothing is written, and init warns with the names and
 * `secrets import --replace` rather than asking. The deployment is set up
 * by then, both values are kept, and init runs without a terminal too.
 */
export const storeInitTeamSecrets = async (
  team: InitTeamSecrets,
  cwd: string,
): Promise<void> => {
  let result: Awaited<ReturnType<typeof storeEnvFileSecrets>>;
  try {
    result = await storeEnvFileSecrets(team.adapter, team.names, cwd);
  } catch (error) {
    if (error instanceof StoredSecretsConflictError) {
      p.log.warn(
        [
          ...(error.names.length === 1
            ? [
                `The ${team.adapter.name} secrets adapter holds another value for:`,
                ...error.names,
                ".env.hotupdater keeps it. Back the stored one up, then run:",
              ]
            : [
                `The ${team.adapter.name} secrets adapter holds other values for:`,
                ...error.names,
                ".env.hotupdater keeps them. Back the stored ones up, then run:",
              ]),
          "npx hot-updater secrets import --replace",
        ].join("\n"),
      );
      return;
    }
    p.log.warn(`${message(error)}\n.env.hotupdater keeps them.`);
    return;
  }
  const { stored, unchanged } = result;
  if (stored.length === 0 && unchanged.length === 0) return;
  // One name a line: credential names are long.
  if (stored.length > 0) {
    p.log.success(
      [`Stored in the ${team.adapter.name} secrets adapter:`, ...stored].join(
        "\n",
      ),
    );
  }
  if (unchanged.length > 0) {
    p.log.success(
      [
        `Already stored in the ${team.adapter.name} secrets adapter:`,
        ...unchanged,
      ].join("\n"),
    );
  }
  p.log.info(
    [
      ".env.hotupdater still sets them, overriding the adapter here.",
      "Delete those lines to read them from the adapter.",
    ].join("\n"),
  );
};

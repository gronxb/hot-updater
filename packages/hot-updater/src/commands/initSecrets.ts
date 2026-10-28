import {
  InitError,
  type InitProviderDefinition,
  loadTeamSecrets,
  MANAGED_CLIENT_CREDENTIAL_ENV,
  p,
  readMissingFromTeamSecrets,
  storeEnvFileSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const list = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

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
 * read from it in one call. Undefined with `localSecrets()`, and when the
 * config can't load, which init says.
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
    p.log.warn(
      `Couldn't load hot-updater.config.ts for its secrets adapter, so credentials stay in .env.hotupdater: ${message(error)}`,
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
    throw new InitError(
      `Couldn't read the ${adapter.name} secrets adapter: ${message(error)}`,
    );
  }
  return { adapter, names, secretsEnv };
};

/**
 * Stores the credentials init saved in `.env.hotupdater` through the team
 * adapter and reads them back. It deletes nothing: the app's build reads
 * `HOT_UPDATER_API_KEY` from the file, and its lines override the adapter
 * on this machine. A failure leaves everything as init wrote it, and says
 * why, such as a store that does not read back what it was given.
 */
export const storeInitTeamSecrets = async (
  team: InitTeamSecrets,
  cwd: string,
): Promise<void> => {
  let stored: readonly string[];
  try {
    stored = await storeEnvFileSecrets(team.adapter, team.names, cwd);
  } catch (error) {
    p.log.warn(`${message(error)}\n.env.hotupdater keeps them.`);
    return;
  }
  if (stored.length === 0) return;
  p.log.success(
    `Stored ${list(stored)} in the ${team.adapter.name} secrets adapter.`,
  );
  p.log.info(
    ".env.hotupdater still sets them: delete those lines, or keep them to override the adapter here.",
  );
};

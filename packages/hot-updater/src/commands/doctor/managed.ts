import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "@hot-updater/cli-tools";

import {
  INIT_PROVIDER_ENV_KEY,
  INIT_PROVIDER_PACKAGES,
  type InitProvider,
  initReplayCommand,
  isInitProvider,
} from "../initProviders";

/**
 * A deployment `hot-updater init` created and reconciles: the provider
 * `.env.hotupdater` records, whose database hot-updater.config.ts still names.
 */
export interface ManagedDeployment {
  readonly provider: InitProvider;
  /** What init deploys beside the database, such as "the Worker". */
  readonly server: string;
  /** Init again with the inputs it saved, which migrates and redeploys. */
  readonly command: string;
}

/**
 * The managed deployment of the project in `cwd`, or null: init records its
 * provider in `.env.hotupdater` (or the environment), and the config's
 * database must be the one that provider's init writes. A project that moved
 * to its own server keeps the record but not the database.
 */
export const readManagedDeployment = async (
  cwd: string,
  databaseName: string,
): Promise<ManagedDeployment | null> => {
  const provider = getHotUpdaterEnvValue(
    await readLoadedHotUpdaterEnv(cwd).catch(() => ({})),
    INIT_PROVIDER_ENV_KEY,
  );
  if (!isInitProvider(provider)) return null;
  const { database, server } = INIT_PROVIDER_PACKAGES[provider];
  if (database !== databaseName) return null;
  return { provider, server, command: initReplayCommand(provider) };
};

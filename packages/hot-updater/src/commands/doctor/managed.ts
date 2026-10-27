import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "@hot-updater/cli-tools";
import type { ConfiguredDatabase } from "@hot-updater/plugin-core";

import {
  INIT_PROVIDER_ENV_KEY,
  INIT_PROVIDER_PACKAGES,
  type InitProvider,
  initReplayCommand,
  isInitProvider,
} from "../initProviders";

/**
 * The resource a database reaches, as its factory marks it: the same key in
 * every provider package (a convention CLAUDE.md documents).
 */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

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
  /**
   * The configured database is the one init's saved inputs describe. False
   * when one side does not say which resource it is, such as a database URL
   * init saved only with consent: init's command then holds only if it is.
   */
  readonly confirmed: boolean;
}

/**
 * The managed deployment of the project in `cwd`, or null. Init records its
 * provider in `.env.hotupdater` (or the environment), and replays against
 * the resources it saved there, so the configured database must be that
 * provider's kind, and must not reach another resource than the saved one.
 * A project that moved to a database of its own keeps the record but not
 * the database.
 */
export const readManagedDeployment = async (
  cwd: string,
  database: ConfiguredDatabase,
): Promise<ManagedDeployment | null> => {
  const env = await readLoadedHotUpdaterEnv(cwd).catch(() => ({}));
  const read = (envKey: string) => getHotUpdaterEnvValue(env, envKey);
  const provider = read(INIT_PROVIDER_ENV_KEY);
  if (!isInitProvider(provider)) return null;
  const { database: name, server, target } = INIT_PROVIDER_PACKAGES[provider];
  if (database.name !== name) return null;
  const configured: unknown = Reflect.get(database, DATABASE_TARGET);
  const saved = target(read);
  const known = typeof configured === "string" && saved !== undefined;
  if (known && configured !== saved) return null;
  return {
    provider,
    server,
    command: initReplayCommand(provider),
    confirmed: known,
  };
};

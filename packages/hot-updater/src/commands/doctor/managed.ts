import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
} from "@hot-updater/cli-tools";
import type {
  AnyHotUpdaterPlugin,
  ConfiguredDatabase,
} from "@hot-updater/plugin-core";

import {
  INIT_BUILD_ENV_KEY,
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

/** The brand Hot Updater's own plugin factories set, read as the server reads it. */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

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
   * Where doctor read init's saved inputs: `.env.hotupdater`, which the
   * command names, or the environment, such as a file the config loads or
   * CI's variables, which the command then needs as well.
   */
  readonly source: "file" | "environment";
  /**
   * The configured database is the one init's saved inputs describe. False
   * when one side does not say which resource it is, such as a database URL
   * init saved only with consent: init's command then holds only if it is.
   */
  readonly confirmed: boolean;
  /**
   * The plugins hot-updater.config.ts lists that are not Hot Updater's own.
   * The managed server runs only the official ones, and init writes that
   * list back into the config, so replaying it would drop these.
   */
  readonly foreignPlugins: readonly string[];
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
  plugins: readonly AnyHotUpdaterPlugin[],
): Promise<ManagedDeployment | null> => {
  const file: Readonly<Record<string, string>> = await readLoadedHotUpdaterEnv(
    cwd,
  ).catch(() => ({}));
  // Every input doctor reads, with the value it used: the environment's
  // first, as init reads them.
  const used = new Map<string, string | undefined>();
  const read = (envKey: string) => {
    const value = getHotUpdaterEnvValue(file, envKey);
    used.set(envKey, value);
    return value;
  };
  const provider = read(INIT_PROVIDER_ENV_KEY);
  if (!isInitProvider(provider)) return null;
  const build = read(INIT_BUILD_ENV_KEY);
  const { database: name, server, target } = INIT_PROVIDER_PACKAGES[provider];
  if (database.name !== name) return null;
  const configured: unknown = Reflect.get(database, DATABASE_TARGET);
  const saved = target(read);
  const known = typeof configured === "string" && saved !== undefined;
  if (known && configured !== saved) return null;
  // `--from-env-file .env.hotupdater` replays these inputs only when the
  // file holds each of them, as doctor read them.
  const fromFile =
    build !== undefined &&
    [...used].every(
      ([envKey, value]) =>
        value === undefined ||
        (Object.hasOwn(file, envKey) && file[envKey]!.trim() === value),
    );
  return {
    provider,
    server,
    command: fromFile
      ? initReplayCommand(provider)
      : `npx hot-updater init --provider ${provider} --build ${build ?? "<build>"} --from-env-file <env file>`,
    source: fromFile ? "file" : "environment",
    confirmed: known,
    foreignPlugins: plugins.flatMap((plugin) =>
      Reflect.get(plugin, OFFICIAL) === true ? [] : [plugin.id],
    ),
  };
};

/**
 * What init's command does, as the line before it: with the inputs doctor
 * read from the environment rather than `.env.hotupdater`, it names the
 * file the command's `<env file>` stands for.
 */
export const replayLead = ({
  source,
}: Pick<ManagedDeployment, "source">): string =>
  source === "file"
    ? "Migrate the database and redeploy the server in one run:"
    : "Pass init's saved inputs as <env file> to migrate and redeploy in one run:";

/**
 * Why init's command does not apply while the config lists plugins the
 * managed server does not run, and what to do instead; undefined when it
 * lists none.
 */
export const foreignPluginsNote = ({
  foreignPlugins,
  server,
}: Pick<ManagedDeployment, "foreignPlugins" | "server">):
  | string
  | undefined => {
  if (foreignPlugins.length === 0) return undefined;
  const one = foreignPlugins.length === 1;
  return `hot-updater.config.ts lists ${one ? "a plugin" : "plugins"} the managed server does not run (${foreignPlugins.join(", ")}): \`hot-updater init\` deploys ${server} with only the official insights(), apiKeys() and remoteConfig(), and running it again sets the plugins in hot-updater.config.ts to those, so it would drop ${one ? "it" : "them"}. Remove ${one ? "it" : "them"} from plugins and run doctor again, which then names init; or, if a server of your own runs ${one ? "it" : "them"} on this database:`;
};

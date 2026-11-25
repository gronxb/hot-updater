import {
  type AnyHotUpdaterPlugin,
  type DatabaseAdapter,
  type HotUpdaterCoreApi,
  type Migrator,
  type PluginClientCredential,
  type PluginClientPlugin,
  type ReleaseLabelFill,
  type SchemaGenerator,
  type ToolingDatabase,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/plugin-core";

import { getHotUpdaterEnvValue } from "./hotUpdaterEnv";
import { p } from "./prompts";

/** A plugin's endpoint on a server's `handlers.client`. */
export interface ServerClientEndpoint {
  /** The id of the plugin that adds it. */
  readonly plugin: string;
  readonly method: string;
  /** Relative to the handler's mount; `:name` segments are parameters. */
  readonly path: string;
}

/**
 * A server definition as tooling reads it: the `hotUpdater` that
 * `createHotUpdater` from `@hot-updater/server` returns, through its
 * public properties.
 */
export interface ServerDefinition {
  /** The database as configured, with the tooling `hot-updater db` runs. */
  readonly database: ToolingDatabase;
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  /** The client plugins an app adds for the plugins: what init prints. */
  readonly clientPlugins: readonly PluginClientPlugin[];
  /** The plugins' client endpoints, which a host that routes by path sends to the server. */
  readonly clientEndpoints: readonly ServerClientEndpoint[];
  /** The plugin that guards client routes; absent when they are public. */
  readonly clientAuth?: {
    readonly plugin: string;
    /** The request headers its decision reads, lowercase. */
    readonly varyHeaders: readonly string[];
  };
  /** Core's API, on the server's own path. */
  readonly core: HotUpdaterCoreApi;
  /** Each plugin's API by plugin id. */
  readonly api: Readonly<Record<string, unknown>>;
}

/** A server definition tooling cannot use, with what to do about it. */
export class ServerDefinitionError extends Error {
  override readonly name = "ServerDefinitionError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Whether `value` has the public properties tooling reads from a server definition. */
export const isServerDefinition = (value: unknown): value is ServerDefinition =>
  isRecord(value) &&
  isRecord(value.database) &&
  typeof value.database.name === "string" &&
  Array.isArray(value.plugins) &&
  Array.isArray(value.clientPlugins) &&
  Array.isArray(value.clientEndpoints) &&
  isRecord(value.core) &&
  isRecord(value.api);

/**
 * `value` as a server definition, or a `ServerDefinitionError` that says
 * what `source`, the module it came from, must export instead.
 */
export const serverDefinitionOf = (
  value: unknown,
  source = "The server definition",
): ServerDefinition => {
  if (isServerDefinition(value)) return value;
  throw new ServerDefinitionError(
    `${source} must export hotUpdater: the server createHotUpdater({ database, storage, plugins }) returns.`,
  );
};

const fail = (message: string): never => {
  throw new ServerDefinitionError(message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !Array.isArray(value);

/** The credential an app sends to client routes. */
export interface ClientCredentialSpec {
  /** Its name in output, such as "API key". */
  readonly label: string;
  /** The request header that carries it, lowercase. */
  readonly header: string;
  /** The environment variable init stores it in. */
  readonly env: string;
}

/** The client-route policy a definition's plugins set, as tooling needs it. */
export interface ClientAuthSpec {
  /** The plugin that provides clientAuth. */
  readonly plugin: string;
  /** The request headers its decision reads, lowercase: what caches key on. */
  readonly varyHeaders: readonly string[];
  readonly credential: ClientCredentialSpec;
}

export interface ProvisionedClientCredential extends ClientCredentialSpec {
  readonly value: string;
}

type CredentialSource = Pick<ServerDefinition, "plugins" | "clientAuth">;

/** The clientAuth plugin's credential contribution, checked. */
const credentialOf = ({
  plugins,
  clientAuth,
}: CredentialSource):
  | { readonly plugin: string; readonly credential: PluginClientCredential }
  | undefined => {
  if (clientAuth === undefined) return undefined;
  const id = clientAuth.plugin;
  const credential = plugins.find((plugin) => plugin.id === id)?.cli
    ?.clientCredential as unknown;
  if (
    !isObject(credential) ||
    typeof credential.label !== "string" ||
    typeof credential.header !== "string" ||
    typeof credential.env !== "string" ||
    typeof credential.generate !== "function" ||
    typeof credential.provision !== "function"
  ) {
    return fail(
      `Plugin "${id}" provides clientAuth but no cli.clientCredential with a label, header, env, generate, and provision, so init cannot give an app its credential.`,
    );
  }
  return {
    plugin: id,
    credential: credential as unknown as PluginClientCredential,
  };
};

/**
 * The client-route policy a definition's plugins set: the plugin that
 * provides clientAuth, the headers its decision reads, and the credential an
 * app sends. Undefined when client routes are public.
 */
export const clientAuthOf = (
  definition: CredentialSource,
): ClientAuthSpec | undefined => {
  const found = credentialOf(definition);
  if (found === undefined) return undefined;
  const { label, header, env } = found.credential;
  return {
    plugin: found.plugin,
    varyHeaders: definition.clientAuth?.varyHeaders ?? [],
    credential: { label, header: header.toLowerCase(), env },
  };
};

/**
 * A new client credential, made without a database, so tooling can save it
 * before it registers it. Undefined when client routes are public.
 */
export const generateClientCredential = (
  definition: CredentialSource,
): string | undefined => credentialOf(definition)?.credential.generate();

/**
 * Provisions the credential an app sends to client routes, through the
 * plugin that provides clientAuth, on the definition's database: a
 * credential the environment or `env` holds is registered again rather
 * than replaced.
 * Undefined when client routes are public.
 */
export const provisionClientCredential = async (
  definition: CredentialSource & Pick<ServerDefinition, "api">,
  input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Names the credential where the plugin stores one. */
    readonly name: string;
  },
): Promise<ProvisionedClientCredential | undefined> => {
  const found = credentialOf(definition);
  if (found === undefined) return undefined;
  const { label, header, env, provision } = found.credential;
  // The environment's value first, then the env files', as init's inputs.
  const existing = getHotUpdaterEnvValue(input.env, env);
  const value = await provision(definition.api[found.plugin], {
    ...(existing ? { existing } : {}),
    name: input.name,
  });
  return { label, header: header.toLowerCase(), env, value };
};

type ToolingSource = Pick<ServerDefinition, "database" | "plugins">;

/** Whether `hot-updater db generate` writes schema files for a definition's database. */
export const generatesSchema = ({
  database,
}: Pick<ServerDefinition, "database">): boolean =>
  database.generateSchema !== undefined;

/** The migrator for a definition's database: core's tables and its plugins' tables. */
export const createMigrator = ({
  database,
  plugins,
}: ToolingSource): Migrator => {
  if (database.createMigrator === undefined) {
    throw new ServerDefinitionError(
      database.generateSchema === undefined
        ? `The ${database.name} database has no migrator; its provider applies the schema.`
        : `The ${database.name} database applies its schema from migration files: run \`hot-updater db generate\`, then apply the file with the provider's tooling.`,
    );
  }
  return database.createMigrator(toolingTargetOf(plugins));
};

/** The schema file `hot-updater db generate` writes for a definition's database. */
export const generateSchema = (
  { database, plugins }: ToolingSource,
  version: Parameters<SchemaGenerator>[0],
  name?: Parameters<SchemaGenerator>[1],
): ReturnType<SchemaGenerator> => {
  if (database.generateSchema === undefined) {
    throw new ServerDefinitionError(
      `The ${database.name} database has no schema generator; run \`hot-updater db migrate\` instead.`,
    );
  }
  return database.generateSchema(version, name, toolingTargetOf(plugins));
};

/** One line for what a release label fill changed, or null for nothing. */
const releaseLabelFillLine = ({
  releases,
  catalogs,
}: ReleaseLabelFill): string | null => {
  const parts = [
    ...(releases > 0
      ? [`labeled ${releases} release${releases === 1 ? "" : "s"}`]
      : []),
    ...(catalogs > 0
      ? [`rebuilt ${catalogs} release catalog${catalogs === 1 ? "" : "s"}`]
      : []),
  ];
  if (parts.length === 0) return null;
  const line = parts.join(" and ");
  return `${line[0]!.toUpperCase()}${line.slice(1)}.`;
};

/**
 * Gives labels to the releases a database holds without one, and rebuilds
 * the release catalogs that lack them, once its schema is migrated:
 * `hot-updater init` and `db migrate` run it. It prints one line when it
 * changed something, and nothing otherwise.
 */
export const fillReleaseLabels = async (
  definition: Pick<ServerDefinition, "core">,
): Promise<ReleaseLabelFill> => {
  const filled = await definition.core.fillReleaseLabels();
  const line = releaseLabelFillLine(filled);
  if (line !== null) p.log.info(line);
  return filled;
};

/** What the Insights plugin's `backfillReleaseRefs` returns. */
interface InsightsBackfill {
  readonly backfillReleaseRefs: () => Promise<{ readonly events: number }>;
}

const insightsBackfillOf = (api: unknown): InsightsBackfill | undefined => {
  const insights = isRecord(api) ? api.insights : undefined;
  return isRecord(insights) &&
    typeof insights.backfillReleaseRefs === "function"
    ? (insights as unknown as InsightsBackfill)
    : undefined;
};

/**
 * The settings row that records the backfill ran, beside the `schema.*`
 * rows and retention's lease: its value is when, in epoch ms.
 */
const INSIGHTS_BACKFILL_KEY = "insights.releaseRefs";

/** A database the CLI reaches directly: `standaloneRepository` has none. */
const adapterOf = (database: unknown): DatabaseAdapter | undefined => {
  const adapter = isRecord(database) ? database.adapter : undefined;
  return isRecord(adapter) && typeof adapter.get === "function"
    ? (adapter as unknown as DatabaseAdapter)
    : undefined;
};

/**
 * Moves the Insights events a 1.1 server keyed by artifact, and their
 * counts, to their releases, once the schema is migrated: `hot-updater
 * init` and `db migrate` run it after the label fill. It runs once a
 * database: it then records the settings row `insights.releaseRefs`, so a
 * later run reads that row and no event. Events a 1.1 process still running
 * records after it stay keyed by artifact until the raw period drops them.
 * It runs on a database the CLI reaches directly; a server deployed apart
 * from the project runs it from its own `db migrate`. It prints one line
 * when it moved something, and nothing otherwise. Init runs it once the new
 * server is deployed, since it is the longest step and a run that stops
 * keeps what it moved.
 */
export const backfillInsightsReleaseRefs = async (definition: {
  readonly api?: Readonly<Record<string, unknown>> | undefined;
  readonly database?: unknown;
}): Promise<number> => {
  const insights = insightsBackfillOf(definition.api);
  const adapter = adapterOf(definition.database);
  if (insights === undefined || adapter === undefined) return 0;
  const [done = null] = await adapter.get(SETTINGS_TABLE, [
    [INSIGHTS_BACKFILL_KEY],
  ]);
  if (done !== null) return 0;
  const { events } = await insights.backfillReleaseRefs().catch(
    (error: unknown) => {
      throw new Error(
        `Moving Insights events to their releases stopped: ${error instanceof Error ? error.message : String(error)} Run the command again to resume it.`,
        { cause: error },
      );
    },
  );
  // A concurrent run that recorded it first, or a busy store, leaves this
  // insert refused: the next run reads the events again and moves none.
  await adapter.write([
    {
      type: "insert",
      table: SETTINGS_TABLE,
      row: { key: INSIGHTS_BACKFILL_KEY, value: String(Date.now()), _v: 0 },
    },
  ]);
  if (events > 0) {
    p.log.info(
      `Moved ${events} Insights event${events === 1 ? "" : "s"} from ${events === 1 ? "its artifact to its release" : "their artifacts to their releases"}.`,
    );
  }
  return events;
};

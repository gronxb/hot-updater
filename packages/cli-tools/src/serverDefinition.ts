import {
  type AnyHotUpdaterPlugin,
  type HotUpdaterCoreApi,
  type Migrator,
  type PluginClientCredential,
  type PluginClientPlugin,
  type SchemaGenerator,
  type StorageAdapter,
  type ToolingDatabase,
  toolingTargetOf,
} from "@hot-updater/plugin-core";

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
  /** The storage as configured, in order. */
  readonly storage: readonly StorageAdapter[];
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
  Array.isArray(value.storage) &&
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
  // A server from before its definition had public properties: handlers
  // without them. `in` reads no getter, so it starts nothing.
  if (isRecord(value) && "handlers" in value) {
    throw new ServerDefinitionError(
      `${source} exports a hotUpdater from an older @hot-updater/server. Upgrade @hot-updater/server to the version of hot-updater.`,
    );
  }
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
 * credential saved in `env` is registered again rather than replaced.
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
  const existing = input.env[env]?.trim();
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

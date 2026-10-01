import {
  type AdapterResource,
  type AnyHotUpdaterPlugin,
  type HotUpdaterCoreApi,
  type Migrator,
  type PluginClientCredential,
  type PluginClientPlugin,
  type PluginCommand,
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
  /** The storage as configured, in order: the CLI uploads to the first. */
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

/** A managed server: where it runs, and the database and storage it runs on. */
export interface ManagedServer {
  /** For messages, such as "Cloudflare". */
  readonly provider: string;
  /** The name its database reports, such as `d1Database`. */
  readonly database: string;
  /** The protocol of its storage's URIs, such as `r2`. */
  readonly storage: string;
  /**
   * The resources the managed server runs on, as its setup made them. The
   * definition's adapters must reach the same, or the CLI would read and
   * write others than the server does.
   */
  readonly resources?: {
    readonly database?: AdapterResource;
    readonly storage?: AdapterResource;
  };
}

/** Refuses an adapter that reaches a resource other than the managed server's. */
const assertSameResource = (
  provider: string,
  adapter: { readonly name: string; readonly resource?: AdapterResource },
  expected: AdapterResource | undefined,
) => {
  const actual = adapter.resource;
  for (const [key, value] of Object.entries(expected ?? {})) {
    const found = actual?.[key];
    if (value === undefined || found === undefined || found === value) {
      continue;
    }
    throw new ServerDefinitionError(
      `The managed ${provider} server runs on ${key} ${value}, which its setup made, but the server definition's ${adapter.name} has ${key} ${found}, so the CLI would read and write another one. Give it ${value}, as .env.hotupdater holds it, or host the server yourself.`,
    );
  }
};

/**
 * The project's server definition, as a managed server runs it. The managed
 * runtime serves the definition on its own database and storage, so the
 * definition's must be the provider's, on the resources its setup made; its
 * plugins are the project's, including none of Hot Updater's own.
 */
export const managedServerDefinitionOf = (
  hotUpdater: unknown,
  { provider, database, storage, resources }: ManagedServer,
): ServerDefinition => {
  const definition = serverDefinitionOf(hotUpdater);
  if (definition.database.name !== database) {
    throw new ServerDefinitionError(
      `The managed ${provider} server runs on ${database}, but the server definition's database is ${definition.database.name}. Use ${database}, or host the server yourself.`,
    );
  }
  const others = definition.storage.filter(
    (adapter) => adapter.protocol !== storage,
  );
  if (definition.storage.length === 0 || others.length > 0) {
    throw new ServerDefinitionError(
      `The managed ${provider} server stores bundles in its ${storage} storage, but the server definition's storage is ${definition.storage.map((adapter) => adapter.name).join(", ") || "empty"}. List only the provider's storage, or host the server yourself.`,
    );
  }
  assertSameResource(provider, definition.database, resources?.database);
  for (const adapter of definition.storage) {
    assertSameResource(provider, adapter, resources?.storage);
  }
  return definition;
};

/** A top-level command a plugin adds to `hot-updater`. */
export interface PluginCommandEntry {
  /** The id of the plugin that adds it. */
  readonly plugin: string;
  readonly command: PluginCommand;
}

const COMMAND_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/u;
// The CLI appends the server config's path to every command that runs.
const RESERVED_ARGUMENT = "configPath";

const fail = (message: string): never => {
  throw new ServerDefinitionError(message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !Array.isArray(value);

const checkCommand = (
  plugin: string,
  value: unknown,
  path: readonly string[],
): PluginCommand => {
  const at = `Plugin "${plugin}" command "${[...path, isObject(value) ? String(value.name) : "?"].join(" ")}"`;
  if (
    !isObject(value) ||
    typeof value.name !== "string" ||
    !COMMAND_NAME.test(value.name) ||
    typeof value.description !== "string"
  ) {
    return fail(
      `${at} needs a name of lowercase words joined by hyphens and a description.`,
    );
  }
  const command = value as unknown as PluginCommand;
  if (
    (typeof command.run === "function") ===
    (command.commands !== undefined)
  ) {
    fail(`${at} needs either subcommands or run, not both.`);
  }
  const names = new Set<string>();
  for (const argument of command.arguments ?? []) {
    if (
      !isObject(argument) ||
      typeof argument.name !== "string" ||
      !ARGUMENT_NAME.test(argument.name) ||
      argument.name === RESERVED_ARGUMENT ||
      names.has(argument.name) ||
      typeof argument.description !== "string"
    ) {
      fail(
        `${at} has an argument that needs a unique camelCase name other than "${RESERVED_ARGUMENT}" and a description.`,
      );
    }
    names.add(argument.name);
  }
  for (const option of command.options ?? []) {
    if (
      !isObject(option) ||
      typeof option.flags !== "string" ||
      !option.flags.includes("--") ||
      typeof option.description !== "string"
    ) {
      fail(`${at} has an option that needs --flags and a description.`);
    }
  }
  if (command.commands !== undefined) {
    if (!Array.isArray(command.commands) || command.commands.length === 0) {
      fail(`${at} needs at least one subcommand.`);
    }
    const subcommands = new Set<string>();
    for (const subcommand of command.commands) {
      const checked = checkCommand(plugin, subcommand, [...path, command.name]);
      if (subcommands.has(checked.name)) {
        fail(`${at} has two subcommands named "${checked.name}".`);
      }
      subcommands.add(checked.name);
    }
  }
  return command;
};

/**
 * The top-level commands a definition's plugins add, each checked. Two
 * plugins may not add the same command.
 */
export const pluginCommandsOf = ({
  plugins,
}: Pick<ServerDefinition, "plugins">): readonly PluginCommandEntry[] => {
  const entries: PluginCommandEntry[] = [];
  for (const plugin of plugins) {
    const commands = plugin.cli?.commands;
    if (commands === undefined) continue;
    const id = String(plugin.id);
    if (!Array.isArray(commands)) {
      fail(`Plugin "${id}" cli.commands must be an array.`);
    }
    for (const value of commands as unknown[]) {
      const command = checkCommand(id, value, []);
      const taken = entries.find(
        (entry) => entry.command.name === command.name,
      );
      if (taken !== undefined) {
        fail(
          `Plugins "${taken.plugin}" and "${id}" both add the command "${command.name}"; keep one.`,
        );
      }
      entries.push({ plugin: id, command });
    }
  }
  return entries;
};

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

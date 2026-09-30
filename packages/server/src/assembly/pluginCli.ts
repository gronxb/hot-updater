import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import type {
  PluginClientCredential,
  PluginCommand,
} from "../plugins/definePlugin";
import { assemblePlugins, HotUpdaterConfigError } from "./assemblePlugins";
import { createDatabasePluginApis } from "./databasePlugins";

/** A top-level command a plugin adds to `hot-updater`. */
export interface PluginCommandEntry {
  /** The id of the plugin that adds it. */
  readonly plugin: string;
  readonly command: PluginCommand;
}

/** The credential an app sends to client routes. */
export interface ClientCredentialSpec {
  /** Its name in output, such as "API key". */
  readonly label: string;
  /** The request header that carries it, lowercase. */
  readonly header: string;
  /** The environment variable init stores it in. */
  readonly env: string;
}

/** The client-route policy a server's plugins set, as tooling needs it. */
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

interface PluginLike {
  readonly id?: unknown;
  readonly provides?: { readonly clientAuth?: unknown };
  readonly cli?: {
    readonly commands?: unknown;
    readonly clientCredential?: unknown;
  };
}

const COMMAND_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9]*$/u;
// The CLI appends the server config's path to every command that runs.
const RESERVED_ARGUMENT = "configPath";

const fail = (message: string): never => {
  throw new HotUpdaterConfigError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pluginsOf = (value: unknown): readonly PluginLike[] =>
  Array.isArray(value)
    ? value.filter(isRecord)
    : fail("plugins must be an array of plugins.");

const checkCommand = (
  plugin: string,
  value: unknown,
  path: readonly string[],
): PluginCommand => {
  const at = `Plugin "${plugin}" command "${[...path, isRecord(value) ? String(value.name) : "?"].join(" ")}"`;
  if (
    !isRecord(value) ||
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
      !isRecord(argument) ||
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
      !isRecord(option) ||
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
 * The top-level commands the plugins add, each checked. Two plugins may not
 * add the same command.
 */
export const pluginCommandsOf = (
  plugins: unknown,
): readonly PluginCommandEntry[] => {
  const entries: PluginCommandEntry[] = [];
  for (const plugin of pluginsOf(plugins)) {
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

/** The clientAuth plugin's credential contribution, checked. */
const credentialOf = (
  plugins: unknown,
):
  | { readonly plugin: string; readonly credential: PluginClientCredential }
  | undefined => {
  const plugin = pluginsOf(plugins).find(
    ({ provides }) => provides?.clientAuth === true,
  );
  if (plugin === undefined) return undefined;
  const id = String(plugin.id);
  const credential = plugin.cli?.clientCredential;
  if (
    !isRecord(credential) ||
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
 * The client-route policy the plugins set: the plugin that provides
 * clientAuth, the headers its decision reads, and the credential an app
 * sends. Undefined when client routes are public. The plugins initialize on
 * a throwaway in-memory database, since `varyHeaders` live on the instance.
 */
export const clientAuthOf = (
  plugins: readonly unknown[],
): ClientAuthSpec | undefined => {
  const found = credentialOf(plugins);
  if (found === undefined) return undefined;
  const { clientAuth } = assemblePlugins(plugins, createMemoryAdapter());
  const { label, header, env } = found.credential;
  return {
    plugin: found.plugin,
    varyHeaders: (clientAuth?.varyHeaders ?? []).map((name) =>
      name.toLowerCase(),
    ),
    credential: { label, header: header.toLowerCase(), env },
  };
};

/**
 * A new client credential, made without a database, so tooling can save it
 * before it registers it. Undefined when client routes are public.
 */
export const generateClientCredential = (
  plugins: readonly unknown[],
): string | undefined => credentialOf(plugins)?.credential.generate();

/**
 * Provisions the credential an app sends to client routes, through the
 * plugin that provides clientAuth, on the tables the server reads: a
 * credential saved in `env` is registered again rather than replaced.
 * Undefined when client routes are public.
 */
export const provisionClientCredential = async (
  database: unknown,
  plugins: readonly unknown[],
  input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Names the credential where the plugin stores one. */
    readonly name: string;
  },
): Promise<ProvisionedClientCredential | undefined> => {
  const found = credentialOf(plugins);
  if (found === undefined) return undefined;
  const { label, header, env, provision } = found.credential;
  const existing = input.env[env]?.trim();
  const value = await provision(
    createDatabasePluginApis(database, plugins)[found.plugin],
    { ...(existing ? { existing } : {}), name: input.name },
  );
  return { label, header: header.toLowerCase(), env, value };
};

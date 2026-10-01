import path from "node:path";

import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import { loadConfig, p } from "@hot-updater/cli-tools";
import type { PluginCommand, PluginCommandUi } from "@hot-updater/plugin-core";
import {
  pluginCommandsOf,
  serverPluginsOf,
  type PluginCommandEntry,
} from "@hot-updater/server/db";

import { ui } from "../utils/cli-ui";
import { loadServerDefinition } from "../utils/loadServer";
import { printBanner } from "../utils/printBanner";
import {
  findDefaultConfigPaths,
  importHotUpdater,
  isConfigFile,
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

/** The help group plugin commands appear under. */
export const PLUGIN_COMMANDS_GROUP = "Plugin commands:";

/** How plugin commands appear, when no plugin list is found. */
export const PLUGIN_COMMANDS_HINT =
  "Plugin commands: none found. Server plugins add commands through the server definition that server in hot-updater.config.ts points at, or one the command names, such as src/hotUpdater.ts.";

/** A project's plugin list, and how its commands reach the database. */
interface PluginSource {
  /** The file that lists the plugins, for messages. */
  readonly from: string;
  readonly plugins: readonly unknown[];
  /** The server config's absolute path, when the list comes from one. */
  readonly configPath?: string;
  /** Each plugin's API, by plugin id, over the server's database. */
  open(): Promise<Readonly<Record<string, unknown>>>;
  dispose(): Promise<void>;
}

/** Ends a plugin command with an exit code, and a message when it has one. */
class CommandExit extends Error {
  readonly code: number;

  constructor(code: number, message = "") {
    super(message);
    this.code = code;
  }
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const serverConfigSource = (
  loaded: LoadHotUpdaterResult,
  cwd: string,
): PluginSource => ({
  from: path.relative(cwd, loaded.absoluteConfigPath),
  plugins: serverPluginsOf(loaded.hotUpdater),
  configPath: loaded.absoluteConfigPath,
  open: async () => loaded.hotUpdater.api ?? {},
  dispose: loaded.dispose,
});

/** The server definition hot-updater.config.ts points at with `server`. */
const configuredServerSource = async (
  server: string,
  cwd: string,
): Promise<PluginSource> => {
  const loaded = await loadServerDefinition(server);
  return {
    from: path.relative(cwd, loaded.path),
    plugins: loaded.plugins,
    configPath: loaded.path,
    open: async () =>
      (loaded.hotUpdater as { readonly api?: Record<string, unknown> }).api ??
      {},
    dispose: loaded.dispose,
  };
};

/**
 * The project's plugin lists, in order: a server definition among `args`,
 * the one hot-updater.config.ts points at, then the default server modules,
 * each loaded only once the one before it is passed over. A default module
 * that fails to load is reported in `failures` and skipped.
 */
async function* findPluginSources(
  args: readonly string[],
  cwd: string,
  failures: string[],
): AsyncGenerator<PluginSource> {
  const named = args.find(
    (arg) => !arg.startsWith("-") && isConfigFile(arg, cwd),
  );
  const seen = new Set<string>();
  if (named !== undefined) {
    const source = serverConfigSource(
      await loadHotUpdater(named, { cwd }),
      cwd,
    );
    seen.add(source.configPath!);
    yield source;
  }
  // The definition the config names fails loudly, unlike a default guess.
  // A self-hosted server's plugins' commands need the definition itself.
  // One already found is not loaded again: the process shares its module,
  // and so its database.
  const { server } = await loadConfig(null);
  if (typeof server === "string" && !seen.has(server)) {
    seen.add(server);
    yield await configuredServerSource(server, cwd);
  }
  for (const configPath of findDefaultConfigPaths(cwd)) {
    if (seen.has(configPath)) continue;
    let loaded: LoadHotUpdaterResult | undefined;
    try {
      loaded = await importHotUpdater(configPath);
    } catch (error) {
      failures.push(`${path.relative(cwd, configPath)}: ${messageOf(error)}`);
      continue;
    }
    if (loaded !== undefined) yield serverConfigSource(loaded, cwd);
  }
}

/** A project's plugin list, found where plugin commands find theirs. */
export interface FoundPluginList {
  /** The file that lists the plugins, for messages. */
  readonly from: string;
  readonly plugins: readonly unknown[];
}

/**
 * The project's first plugin list, as plugin commands look for theirs: a
 * server definition among `args`, the one hot-updater.config.ts points at,
 * then the default server modules. Undefined when the project has none; one
 * that fails to load is reported in `failures`.
 */
export const findPluginList = async (
  args: readonly string[],
  cwd: string,
  failures: string[] = [],
): Promise<FoundPluginList | undefined> => {
  for await (const source of findPluginSources(args, cwd, failures)) {
    await source.dispose();
    return { from: source.from, plugins: source.plugins };
  }
  return undefined;
};

const pluginUi: PluginCommandUi = {
  block: (heading, lines) => ui.block(heading, [...lines]),
  kv: (label, value) => ui.kv(label, value),
  table: (columns, rows) => ui.table(columns, rows),
  id: (value) => ui.id(value),
  muted: (value) => ui.muted(value),
  success: (value) => ui.success(value),
  danger: (value) => ui.danger(value),
  warning: (value) => ui.warning(value),
  message: (text) => p.log.message(text),
  info: (text) => p.log.info(text),
  warn: (text) => p.log.warn(text),
  print: (text) => console.log(text),
  confirm: async (message) => {
    if (!process.stdin.isTTY) {
      throw new CommandExit(
        1,
        `${message} Re-run with -y in a non-interactive shell.`,
      );
    }
    const confirmed = await p.confirm({ initialValue: false, message });
    if (p.isCancel(confirmed) || !confirmed) throw new CommandExit(2);
  },
};

interface PluginRun {
  readonly source: PluginSource;
  readonly plugin: string;
  readonly command: PluginCommand;
  /** Such as `hot-updater api-key create`, for messages. */
  readonly usage: string;
  readonly args: Readonly<Record<string, string | undefined>>;
  readonly options: Readonly<Record<string, unknown>>;
  /** The server config the command line names, if it names one. */
  readonly configPath: string | undefined;
}

/** Runs a plugin command, then disposes the source it ran over. */
const runPluginCommand = async (run: PluginRun, cwd: string) => {
  const { command, plugin, args, options } = run;
  let source = run.source;
  try {
    if (
      run.configPath !== undefined &&
      path.resolve(cwd, run.configPath) !== source.configPath
    ) {
      await source.dispose();
      source = serverConfigSource(
        await loadHotUpdater(run.configPath, { cwd }),
        cwd,
      );
    }
    if (options["json"] !== true) printBanner();
    const apis = await source.open();
    const api = apis[plugin];
    if (api === undefined) {
      throw new Error(`${source.from} does not run the plugin "${plugin}".`);
    }
    // pluginCommandsOf checks that every command without subcommands runs.
    await command.run?.({ api, args, options, ui: pluginUi });
  } catch (error) {
    if (error instanceof CommandExit) {
      if (error.message) p.log.error(error.message);
      process.exitCode = error.code;
    } else {
      p.log.error(messageOf(error));
      process.exitCode = 1;
    }
  } finally {
    await source.dispose();
  }
};

const addCommand = (
  parent: CommandUnknownOpts,
  plugin: string,
  command: PluginCommand,
  usage: string,
  source: PluginSource,
  cwd: string,
): CommandUnknownOpts => {
  const added = parent
    .command(command.name)
    .description(command.description) as CommandUnknownOpts;
  if (command.commands !== undefined) {
    for (const subcommand of command.commands) {
      addCommand(
        added,
        plugin,
        subcommand,
        `${usage} ${subcommand.name}`,
        source,
        cwd,
      );
    }
    return added;
  }
  const declared = command.arguments ?? [];
  for (const argument of declared) {
    added.argument(
      argument.required === false ? `[${argument.name}]` : `<${argument.name}>`,
      argument.description,
    );
  }
  added.argument(
    "[configPath]",
    "path to the server config that exports hotUpdater",
  );
  for (const option of command.options ?? []) {
    if (option.required) added.requiredOption(option.flags, option.description);
    else added.option(option.flags, option.description);
  }
  added.action(async (...values: unknown[]) => {
    await runPluginCommand(
      {
        source,
        plugin,
        command,
        usage,
        args: Object.fromEntries(
          declared.map(({ name }, index) => [
            name,
            values[index] as string | undefined,
          ]),
        ),
        options: values[declared.length + 1] as Record<string, unknown>,
        configPath: values[declared.length] as string | undefined,
      },
      cwd,
    );
  });
  return added;
};

const isCoreCommand = (program: CommandUnknownOpts, name: string) =>
  name === "help" ||
  program.commands.some(
    (command) => command.name() === name || command.aliases().includes(name),
  );

/** Adds a source's plugin commands under the help group, each marked with its plugin. */
const addPluginCommands = (
  program: CommandUnknownOpts,
  entries: readonly PluginCommandEntry[],
  source: PluginSource,
  cwd: string,
) => {
  for (const { plugin, command } of entries) {
    addCommand(
      program,
      plugin,
      { ...command, description: `${command.description} (${plugin})` },
      `hot-updater ${command.name}`,
      source,
      cwd,
    ).helpGroup(PLUGIN_COMMANDS_GROUP);
  }
};

const listCommands = (
  from: string,
  entries: readonly PluginCommandEntry[],
): string =>
  entries.length === 0
    ? `No plugin in ${from} adds commands.`
    : [
        `Plugin commands in ${from}:`,
        ...entries.map(
          ({ plugin, command }) => `  ${command.name} (${plugin})`,
        ),
      ].join("\n");

/**
 * Adds the commands of the project's plugins to `program` before it parses
 * `argv`. Core commands load nothing: only help and a command core does not
 * have look for the project's plugin lists. A plugin command runs over the
 * list it was found in.
 */
export async function registerPluginCommands(
  program: CommandUnknownOpts,
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<void> {
  const [first, ...rest] = argv.slice(2);
  const help =
    first === undefined ||
    first === "help" ||
    first === "--help" ||
    first === "-h";
  // `hot-updater help <command>` looks for that command.
  const name = help ? rest[0] : first;
  if (
    name !== undefined &&
    (name.startsWith("-") || isCoreCommand(program, name))
  ) {
    return;
  }
  const failures: string[] = [];
  let listed:
    | { source: PluginSource; entries: readonly PluginCommandEntry[] }
    | undefined;
  try {
    for await (const source of findPluginSources(
      argv.slice(3),
      cwd,
      failures,
    )) {
      // A plugin command named like a core command is never reachable.
      const entries = pluginCommandsOf(source.plugins).filter(
        ({ command }) => !isCoreCommand(program, command.name),
      );
      if (
        name !== undefined &&
        entries.some(({ command }) => command.name === name)
      ) {
        if (listed !== undefined) await listed.source.dispose();
        addPluginCommands(program, entries, source, cwd);
        return;
      }
      if (listed === undefined) {
        listed = { source, entries };
        if (name === undefined) break;
      } else {
        await source.dispose();
      }
    }
  } catch (error) {
    await listed?.source.dispose();
    if (!help) {
      p.log.error(messageOf(error));
      process.exit(1);
    }
    // Help still lists the core commands.
    program.addHelpText(
      "after",
      `\nCould not list plugin commands: ${messageOf(error)}`,
    );
    return;
  }
  if (listed === undefined) {
    program.addHelpText("after", `\n${PLUGIN_COMMANDS_HINT}`);
  } else {
    addPluginCommands(program, listed.entries, listed.source, cwd);
  }
  if (!help) {
    // After `error: unknown command`, say what the project's plugins add.
    program.showHelpAfterError(
      [
        listed === undefined
          ? PLUGIN_COMMANDS_HINT
          : listCommands(listed.source.from, listed.entries),
        ...failures.map(
          (failure) => `Could not look for plugin commands in ${failure}`,
        ),
      ].join("\n"),
    );
  }
}

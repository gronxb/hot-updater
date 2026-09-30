import path from "node:path";

import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import {
  HOT_UPDATER_PLUGINS_PATH,
  loadConfig,
  loadHotUpdaterPlugins,
  p,
} from "@hot-updater/cli-tools";
import {
  type ConfiguredDatabase,
  isRemoteDatabase,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginApis,
  pluginCommandsOf,
  serverPluginsOf,
  type PluginCommandEntry,
} from "@hot-updater/server/db";
import type {
  PluginCommand,
  PluginCommandUi,
} from "@hot-updater/server/plugins";

import { ui } from "../utils/cli-ui";
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
export const PLUGIN_COMMANDS_HINT = `Plugin commands: none found. Server plugins add commands through ${HOT_UPDATER_PLUGINS_PATH} or a server config such as src/hotUpdater.ts.`;

type OpenedDatabase =
  | {
      readonly remote: false;
      /** Each plugin's API, by plugin id. */
      readonly apis: Readonly<Record<string, unknown>>;
    }
  | { readonly remote: true };

/** A project's plugin list, and how its commands reach the database. */
interface PluginSource {
  /** The file that lists the plugins, for messages. */
  readonly from: string;
  readonly plugins: readonly unknown[];
  /** The server config's absolute path, when the list comes from one. */
  readonly configPath?: string;
  open(): Promise<OpenedDatabase>;
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
  open: async () => ({ remote: false, apis: loaded.hotUpdater.api ?? {} }),
  dispose: loaded.dispose,
});

/** `hotUpdater.plugins.ts`, over the database `hot-updater.config.ts` names. */
const pluginsFileSource = (plugins: readonly unknown[]): PluginSource => {
  let database: ConfiguredDatabase | undefined;
  return {
    from: HOT_UPDATER_PLUGINS_PATH,
    plugins,
    open: async () => {
      const opened = (await loadConfig(null)).database;
      database = opened;
      return isRemoteDatabase(opened)
        ? { remote: true }
        : { remote: false, apis: createDatabasePluginApis(opened, plugins) };
    },
    dispose: async () => {
      await database?.dispose?.();
    },
  };
};

/**
 * The project's plugin lists, in order: a server config file among `args`,
 * `hotUpdater.plugins.ts`, then the default server configs, each loaded
 * only once the one before it is passed over. A default config that fails
 * to load is reported in `failures` and skipped.
 */
async function* findPluginSources(
  args: readonly string[],
  cwd: string,
  failures: string[],
): AsyncGenerator<PluginSource> {
  const named = args.find(
    (arg) => !arg.startsWith("-") && isConfigFile(arg, cwd),
  );
  if (named !== undefined) {
    yield serverConfigSource(await loadHotUpdater(named, { cwd }), cwd);
  }
  const plugins = await loadHotUpdaterPlugins(cwd);
  if (plugins !== undefined) yield pluginsFileSource(plugins);
  for (const configPath of findDefaultConfigPaths(cwd)) {
    if (named !== undefined && path.resolve(cwd, named) === configPath) {
      continue;
    }
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
  const { command, plugin, usage, args, options } = run;
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
    const database = await source.open();
    if (database.remote) {
      throw new Error(
        `${usage} needs a database the CLI opens itself, but hot-updater.config.ts reaches a self-hosted server through its admin API. Pass the config that exports your server's hotUpdater: ${usage} <path>.`,
      );
    }
    const api = database.apis[plugin];
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

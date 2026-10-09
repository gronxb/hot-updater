import path from "node:path";

import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  type HotUpdaterCoreApi,
  isRemoteDatabase,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";

import { loadServer } from "../../utils/loadServer";
import {
  findDefaultConfigPaths,
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./load-hot-updater";

/** The server a plugin command works on, and what closes it. */
export interface PluginServer {
  /** Core's API: the server's own path, or its admin API over standaloneRepository. */
  readonly core: HotUpdaterCoreApi;
  /** The plugins as configured. */
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  /** Each plugin's API by id; undefined over standaloneRepository, whose plugins run on the server. */
  readonly api: Readonly<Record<string, unknown>> | undefined;
  /** The admin API of the server standaloneRepository reaches; undefined over the server's own database. */
  readonly fetchAdmin: RemoteDatabase["fetchAdmin"] | undefined;
  /** The server definition's path; undefined for hot-updater.config.ts. */
  readonly definitionPath: string | undefined;
  dispose(): Promise<void>;
}

/** What a command needs from one official plugin, for its messages. */
export interface PluginRequirement {
  /** The plugin's id, which assembly reserves for the official plugin. */
  readonly id: string;
  /** How a config adds it, such as `apiKeys()`. */
  readonly call: string;
  /** How hot-updater.config.ts imports it. */
  readonly importLine: string;
  /** How a createHotUpdater server definition imports it. */
  readonly serverImportLine: string;
}

const fromDefinition = (loaded: LoadHotUpdaterResult): PluginServer => ({
  core: loaded.hotUpdater.core,
  plugins: loaded.hotUpdater.plugins,
  api: loaded.hotUpdater.api,
  fetchAdmin: undefined,
  definitionPath: path.relative(process.cwd(), loaded.absoluteConfigPath),
  dispose: loaded.dispose,
});

/**
 * The server definition `serverPath` names, else the server
 * hot-updater.config.ts describes when it sets `database`, else a server
 * project's `src/hotUpdater.*` or `src/db.*`.
 */
export const openPluginServer = async (
  serverPath: string | undefined,
): Promise<PluginServer> => {
  const cwd = process.cwd();
  if (serverPath?.trim()) {
    return fromDefinition(await loadHotUpdater(serverPath, { cwd }));
  }
  const config = await loadConfig(null);
  if (config.database !== undefined) {
    const server = await loadServer(config);
    return {
      core: server.core,
      plugins: server.plugins,
      api: server.api,
      fetchAdmin: isRemoteDatabase(server.database)
        ? server.database.fetchAdmin
        : undefined,
      definitionPath: undefined,
      dispose: server.dispose,
    };
  }
  if (findDefaultConfigPaths(cwd).length > 0) {
    return fromDefinition(await loadHotUpdater("", { cwd }));
  }
  throw new Error(
    "Set database and plugins in hot-updater.config.ts, or pass the path to your server definition, such as src/hotUpdater.ts.",
  );
};

/** Throws, naming where to add it, when the server's plugins list no `plugin`. */
export const requirePlugin = (
  server: PluginServer,
  { id, call, importLine, serverImportLine }: PluginRequirement,
): void => {
  if (server.plugins.some((plugin) => plugin.id === id)) return;
  throw new Error(
    server.definitionPath === undefined
      ? `hot-updater.config.ts lists no ${call} in plugins. Add ${call} to plugins, the same plugin your server runs (${importLine}).`
      : `${server.definitionPath} lists no ${call} in plugins. Add ${call} to its plugins (${serverImportLine}).`,
  );
};

/**
 * Runs `run` over the server, reports a failure with exit code 1, and closes
 * what it opened.
 */
export const withPluginServer = async (
  serverPath: string | undefined,
  run: (server: PluginServer) => Promise<void>,
): Promise<void> => {
  let server: PluginServer | undefined;
  try {
    server = await openPluginServer(serverPath);
    await run(server);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await server?.dispose();
  }
};

/**
 * Whether to go ahead: `-y`, or the user's answer. Without a terminal to ask
 * in, it exits 1; a declined or cancelled prompt exits 2.
 */
export const confirmAction = async (
  message: string,
  yes: boolean | undefined,
): Promise<boolean> => {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    p.log.error(`${message} Re-run with -y in a non-interactive shell.`);
    process.exitCode = 1;
    return false;
  }
  const confirmed = await p.confirm({ initialValue: false, message });
  if (p.isCancel(confirmed) || !confirmed) {
    process.exitCode = 2;
    return false;
  }
  return true;
};

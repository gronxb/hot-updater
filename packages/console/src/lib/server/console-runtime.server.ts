import {
  type ConfiguredDatabase,
  isRemoteServer,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import { serverDefinitionOf } from "@hot-updater/server/db";

import type {
  ConsoleAuthAdapter,
  HotUpdaterConsoleConfigSource,
} from "../../index";

/** What the console runs on, from the server its config names. */
export interface ResolvedConsoleConfig {
  readonly gitUrl?: string;
  /** The server's database, or its admin API. */
  readonly database: ConfiguredDatabase;
  /** The server's storage; each bundle file is read with its protocol's. */
  readonly storage: readonly StorageAdapter[];
  /** The definition's plugins; a remote server lists its own on `/version`. */
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}

export const getConsoleAuthAdapter = async (): Promise<ConsoleAuthAdapter> => {
  const module = await import("virtual:hot-updater-console/auth");
  return module.default;
};

export const resolveConsoleConfig = async (
  request: Request,
): Promise<ResolvedConsoleConfig> => {
  const { default: source } =
    (await import("virtual:hot-updater-console/config")) as {
      readonly default: HotUpdaterConsoleConfigSource;
    };

  const config = typeof source === "function" ? await source(request) : source;
  const gitUrl = config.gitUrl === undefined ? {} : { gitUrl: config.gitUrl };
  if (isRemoteServer(config.server)) {
    return {
      ...gitUrl,
      database: config.server,
      storage: config.server.storage,
    };
  }
  const definition = serverDefinitionOf(config.server);
  if (definition === undefined) {
    throw new Error(
      "The console's server must be your server definition, the hotUpdater that createHotUpdater returns, or standaloneRepository(...).",
    );
  }
  return {
    ...gitUrl,
    database: definition.database,
    storage: definition.storage,
    plugins: definition.plugins,
  };
};

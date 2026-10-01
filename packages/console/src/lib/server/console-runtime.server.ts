import {
  type ConfiguredDatabase,
  type HotUpdaterCoreApi,
  isRemoteServer,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import type { HotUpdaterAPI } from "@hot-updater/server";

import type {
  ConsoleAuthAdapter,
  HotUpdaterConsoleConfigSource,
} from "../../index";

/** What the console runs on, from the server its config names. */
export interface ResolvedConsoleConfig {
  readonly gitUrl?: string;
  /** The server's database, or its admin API. */
  readonly database: ConfiguredDatabase;
  /**
   * Core's API: the definition's, so the console's writes take the server's
   * own path, or a self-hosted server's admin API.
   */
  readonly core: HotUpdaterCoreApi;
  /** The server's storage; each bundle file is read with its protocol's. */
  readonly storage: readonly StorageAdapter[];
  /** The definition's plugins; a remote server lists its own on `/version`. */
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
  /** The definition's plugin APIs by id, which serve the plugins' features. */
  readonly api?: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * `value` as a server definition: the hotUpdater `createHotUpdater`
 * returns, read through its public properties.
 */
const serverDefinitionOf = (value: unknown): HotUpdaterAPI => {
  if (
    isRecord(value) &&
    isRecord(value.database) &&
    Array.isArray(value.storage) &&
    Array.isArray(value.plugins) &&
    isRecord(value.core) &&
    isRecord(value.api)
  ) {
    return value as unknown as HotUpdaterAPI;
  }
  // A server from before its definition had public properties: handlers
  // without them. `in` reads no getter, so it starts nothing.
  if (isRecord(value) && "handlers" in value) {
    throw new Error(
      "The console's server comes from an older @hot-updater/server. Upgrade @hot-updater/server to the version of @hot-updater/console.",
    );
  }
  throw new Error(
    "The console's server must be your server definition, the hotUpdater that createHotUpdater returns, or standaloneRepository(...).",
  );
};

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
      core: config.server.core,
      storage: config.server.storage,
    };
  }
  const definition = serverDefinitionOf(config.server);
  return {
    ...gitUrl,
    database: definition.database,
    core: definition.core,
    storage: definition.storage,
    plugins: definition.plugins,
    api: definition.api,
  };
};

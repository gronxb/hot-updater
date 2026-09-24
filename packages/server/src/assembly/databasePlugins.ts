import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import {
  engineAdapterOf,
  OFF_ENGINE_DATABASE,
  type CoreApi,
} from "../core/api";
import type { CoreStorage } from "../core/reads";
import type { ReadMeasurement } from "../database/engine";
import type {
  AnyHotUpdaterPlugin,
  ClientAuth,
  PluginApis,
} from "../plugins/definePlugin";
import { assemblePlugins } from "./assemblePlugins";

/**
 * The plugins' APIs by plugin id over a configured database, assembled as
 * `createHotUpdater` assembles them: how the console runs Insights and API
 * keys in process, and how init provisions a key, on the tables the server
 * uses. A database off the storage engine, `standaloneRepository` included,
 * is refused: its server runs the plugins.
 */
export function createDatabasePluginApis<
  const TPlugins extends readonly AnyHotUpdaterPlugin[],
>(
  database: unknown,
  plugins: TPlugins,
  options?: { readonly now?: () => number },
): PluginApis<TPlugins>;
export function createDatabasePluginApis(
  database: unknown,
  plugins: readonly unknown[],
  options?: { readonly now?: () => number },
): Readonly<Record<string, unknown>>;
export function createDatabasePluginApis(
  database: unknown,
  plugins: readonly unknown[],
  options: { readonly now?: () => number } = {},
): Readonly<Record<string, unknown>> {
  const adapter = engineAdapterOf(database);
  if (adapter === undefined) throw new Error(OFF_ENGINE_DATABASE);
  return assemblePlugins(plugins, adapter, options).api;
}

export interface MeasuredDatabaseOptions {
  readonly now?: () => number;
  /** How core reads bundle manifests and resolves file URLs, for artifact resolution. */
  readonly storage?: CoreStorage;
}

/** Core and the plugins' APIs on one engine in verify mode, and its read meter. */
export interface MeasuredDatabase<TApi = Readonly<Record<string, unknown>>> {
  readonly core: CoreApi;
  readonly api: TApi;
  /** The client-route policy, when a plugin provides one. */
  readonly clientAuth?: ClientAuth;
  /** Runs `read` and reports what it read at both boundaries. */
  measureReads<T>(read: () => Promise<T>): Promise<ReadMeasurement<T>>;
}

/**
 * Core and the plugins over a storage adapter, assembled as
 * `createHotUpdater` assembles them but on an engine in verify mode, with
 * that engine's `measureReads`: what read-budget suites measure. The adapter
 * runs as given, without the schema fence.
 */
export function createMeasuredDatabase<
  const TPlugins extends readonly AnyHotUpdaterPlugin[],
>(
  adapter: DatabaseAdapter,
  plugins: TPlugins,
  options?: MeasuredDatabaseOptions,
): MeasuredDatabase<PluginApis<TPlugins>>;
export function createMeasuredDatabase(
  adapter: DatabaseAdapter,
  plugins: readonly unknown[],
  options?: MeasuredDatabaseOptions,
): MeasuredDatabase;
export function createMeasuredDatabase(
  adapter: DatabaseAdapter,
  plugins: readonly unknown[],
  options: MeasuredDatabaseOptions = {},
): MeasuredDatabase {
  const { core, api, clientAuth, measureReads } = assemblePlugins(
    plugins,
    adapter,
    { ...options, verify: true },
  );
  return {
    core,
    api,
    ...(clientAuth === undefined ? {} : { clientAuth }),
    measureReads: measureReads!,
  };
}

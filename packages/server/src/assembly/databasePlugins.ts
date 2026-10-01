import type { EngineDatabase } from "@hot-updater/plugin-core";

import { engineAdapterOf, OFF_ENGINE_DATABASE } from "../core/api";
import type { AnyHotUpdaterPlugin, PluginApis } from "../plugins/definePlugin";
import { assemblePlugins } from "./assemblePlugins";

/**
 * The plugins' APIs by plugin id over a configured database, assembled as
 * `createHotUpdater` assembles them: how the console and the CLI run a
 * plugin in process, on the tables the server uses. A database off the
 * storage engine, `standaloneRepository` included, is refused: its server
 * runs the plugins.
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
  // Batched aggregates compact before they are read, as on the server.
  const { name, aggregateBatching } = database as Partial<EngineDatabase>;
  return assemblePlugins(
    plugins,
    {
      name: name ?? "database",
      adapter,
      ...(aggregateBatching === undefined ? {} : { aggregateBatching }),
    },
    options,
  ).api;
}

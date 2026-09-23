import { engineAdapterOf, OFF_ENGINE_DATABASE } from "../core/api";
import { assemblePlugins } from "./assemblePlugins";

/**
 * The plugins' APIs by plugin id over a configured database, assembled as
 * `createHotUpdater` assembles them: how the console runs Insights and API
 * keys in process, on the same tables the server uses. A database off the
 * storage engine, `standaloneRepository` included, is refused: its server
 * runs the plugins.
 */
export const createDatabasePluginApis = (
  database: unknown,
  plugins: readonly unknown[],
  options: { readonly now?: () => number } = {},
): Readonly<Record<string, unknown>> => {
  const adapter = engineAdapterOf(database);
  if (adapter === undefined) throw new Error(OFF_ENGINE_DATABASE);
  return assemblePlugins(plugins, adapter, options).api;
};

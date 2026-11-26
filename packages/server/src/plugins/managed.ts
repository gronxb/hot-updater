import { apiKeys } from "@hot-updater/plugin-api-keys/server";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import { insights } from "@hot-updater/plugin-insights/server";
import { remoteConfig } from "@hot-updater/plugin-remote-config/server";

import { HotUpdaterConfigError } from "../assembly/configError";

/**
 * The official plugins a managed provider's prebuilt server can run, in the
 * order it runs them. Each is optional: the selection a deployment carries
 * names the ones its server runs.
 */
export const MANAGED_PLUGIN_IDS = [
  "insights",
  "apiKeys",
  "remoteConfig",
] as const;

export type ManagedPluginId = (typeof MANAGED_PLUGIN_IDS)[number];

/** The selection that runs no plugin, which an empty setting can't say. */
const NONE = "none";

const factories: Readonly<Record<ManagedPluginId, () => AnyHotUpdaterPlugin>> =
  {
    insights: () => insights(),
    apiKeys: () => apiKeys(),
    remoteConfig: () => remoteConfig(),
  };

const isManagedPluginId = (id: string): id is ManagedPluginId =>
  (MANAGED_PLUGIN_IDS as readonly string[]).includes(id);

/**
 * The plugins a selection names, in the order a managed server runs them.
 * A selection is the text a deployment keeps, such as `insights,apiKeys`:
 * - a missing or blank one selects every plugin, as servers deployed before
 *   the selection existed run them;
 * - `none` selects no plugin.
 */
export const parseManagedPlugins = (
  selection: string | undefined,
): readonly ManagedPluginId[] => {
  const text = selection?.trim();
  if (!text) return MANAGED_PLUGIN_IDS;
  if (text === NONE) return [];
  const ids = text
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unknown = ids.filter((id) => !isManagedPluginId(id));
  if (unknown.length > 0) {
    throw new HotUpdaterConfigError(
      `Unknown managed ${unknown.length === 1 ? "plugin" : "plugins"} ${unknown.map((id) => `"${id}"`).join(", ")}. List ${MANAGED_PLUGIN_IDS.join(", ")} separated by commas, or "${NONE}" to run no plugin.`,
    );
  }
  return MANAGED_PLUGIN_IDS.filter((id) => ids.includes(id));
};

/** The selection text for `ids`, which {@link parseManagedPlugins} reads back. */
export const formatManagedPlugins = (ids: readonly ManagedPluginId[]): string =>
  ids.length === 0
    ? NONE
    : MANAGED_PLUGIN_IDS.filter((id) => ids.includes(id)).join(",");

/** `createHotUpdater`'s options for the plugins a managed server runs. */
export interface ManagedPluginOptions {
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  /** Set when the selection leaves out `apiKeys()`, which guards client routes. */
  readonly clientAccess?: "public";
}

/**
 * What a managed server passes to `createHotUpdater` for a selection: the
 * plugins it names with their default options, and public client routes
 * when `apiKeys()` is not among them.
 */
export const managedPlugins = (
  selection: string | readonly ManagedPluginId[] | undefined,
): ManagedPluginOptions => {
  const ids =
    selection === undefined || typeof selection === "string"
      ? parseManagedPlugins(selection)
      : MANAGED_PLUGIN_IDS.filter((id) => selection.includes(id));
  const plugins = ids.map((id) => factories[id]());
  return plugins.some((plugin) => plugin.provides?.clientAuth)
    ? { plugins }
    : { plugins, clientAccess: "public" };
};

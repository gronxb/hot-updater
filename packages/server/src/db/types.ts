import type { DatabasePlugin } from "@hot-updater/plugin-core";
import type { FumaDBAdapter } from "fumadb/adapters";

export type DatabasePluginFactory = (args: { cwd: string }) => DatabasePlugin;

export type DatabaseAdapter =
  | FumaDBAdapter
  | DatabasePlugin
  | DatabasePluginFactory;

export function isDatabasePluginFactory(
  adapter: DatabaseAdapter,
): adapter is DatabasePluginFactory {
  return typeof adapter === "function";
}

export function isDatabasePlugin(
  adapter: DatabaseAdapter,
): adapter is DatabasePlugin {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "getBundleById" in adapter &&
    "getBundles" in adapter &&
    "getChannels" in adapter
  );
}

export function isFumaAdapter(
  adapter: DatabaseAdapter,
): adapter is FumaDBAdapter {
  return !isDatabasePluginFactory(adapter) && !isDatabasePlugin(adapter);
}

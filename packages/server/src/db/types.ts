import type {
  AppUpdateInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";
import type { FumaDBAdapter } from "fumadb/adapters";
import type { PaginationInfo } from "../types";

export type DatabasePluginFactory = () => DatabasePlugin;

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

export interface DatabaseAPI {
  getBundleById(id: string): Promise<Bundle | null>;
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getAppUpdateInfo(args: GetBundlesArgs): Promise<AppUpdateInfo | null>;
  getChannels(): Promise<string[]>;
  getBundles(options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }): Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  insertBundle(bundle: Bundle): Promise<void>;
  updateBundleById(bundleId: string, newBundle: Partial<Bundle>): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
}

export type StoragePluginFactory = () => StoragePlugin;

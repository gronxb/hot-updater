import type {
  AppUpdateInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  DatabasePlugin,
  HotUpdaterContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import type { FumaDBAdapter } from "fumadb/adapters";
import type { PaginationInfo } from "../types";

export type DatabasePluginFactory<TEnv = unknown> = () => DatabasePlugin<TEnv>;

export type DatabaseAdapter<TEnv = unknown> =
  | FumaDBAdapter
  | DatabasePlugin<TEnv>
  | DatabasePluginFactory<TEnv>;

export function isDatabasePluginFactory<TEnv = unknown>(
  adapter: DatabaseAdapter<TEnv>,
): adapter is DatabasePluginFactory<TEnv> {
  return typeof adapter === "function";
}

export function isDatabasePlugin<TEnv = unknown>(
  adapter: DatabaseAdapter<TEnv>,
): adapter is DatabasePlugin<TEnv> {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "getBundleById" in adapter &&
    "getBundles" in adapter &&
    "getChannels" in adapter
  );
}

export function isFumaAdapter<TEnv = unknown>(
  adapter: DatabaseAdapter<TEnv>,
): adapter is FumaDBAdapter {
  return !isDatabasePluginFactory(adapter) && !isDatabasePlugin(adapter);
}

export interface DatabaseAPI<TEnv = unknown> {
  getBundleById(
    id: string,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<Bundle | null>;
  getUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<UpdateInfo | null>;
  getAppUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<AppUpdateInfo | null>;
  getChannels(context?: HotUpdaterContext<TEnv>): Promise<string[]>;
  getBundles(
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  insertBundle(
    bundle: Bundle,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<void>;
  updateBundleById(
    bundleId: string,
    newBundle: Partial<Bundle>,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<void>;
  deleteBundleById(
    bundleId: string,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<void>;
}

export type StoragePluginFactory<TEnv = unknown> = () => StoragePlugin<TEnv>;

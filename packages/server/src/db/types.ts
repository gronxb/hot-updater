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
import { sqlProviders, type Provider, type SQLProvider } from "fumadb";

import type { PaginatedResult } from "../types";

export type DatabasePluginFactory<TContext = unknown> =
  () => DatabasePlugin<TContext>;

export type ORMProvider = Provider;
export type ORMSQLProvider = SQLProvider;

export interface ORMDatabaseAdapter {
  name: string;
  provider?: ORMProvider;
  createORM(this: any, schema: any): unknown;
  getSchemaVersion(this: any): Promise<string | undefined>;
  generateSchema?: (
    this: any,
    schema: any,
    schemaName: string,
  ) => {
    code: string;
    path: string;
  };
  createMigrationEngine?: (this: any) => unknown;
}

export type DatabaseAdapter<TContext = unknown> =
  | ORMDatabaseAdapter
  | DatabasePlugin<TContext>
  | DatabasePluginFactory<TContext>;

export function isDatabasePluginFactory<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabasePluginFactory<TContext> {
  return typeof adapter === "function";
}

export function isDatabasePlugin<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is DatabasePlugin<TContext> {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    "getBundleById" in adapter &&
    "getBundles" in adapter &&
    "getChannels" in adapter
  );
}

export function isFumaAdapter<TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): adapter is ORMDatabaseAdapter {
  return !isDatabasePluginFactory(adapter) && !isDatabasePlugin(adapter);
}

export function getSQLProvider(
  provider: ORMProvider | undefined,
): ORMSQLProvider | undefined {
  if (!provider) {
    return undefined;
  }

  return sqlProviders.includes(provider as ORMSQLProvider)
    ? (provider as ORMSQLProvider)
    : undefined;
}

export interface DatabaseAPI<TContext = unknown> {
  getBundleById(
    id: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Bundle | null>;
  getUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<UpdateInfo | null>;
  getAppUpdateInfo(
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<AppUpdateInfo | null>;
  getChannels(context?: HotUpdaterContext<TContext>): Promise<string[]>;
  getBundles(
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ): Promise<PaginatedResult>;
  insertBundle(
    bundle: Bundle,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  updateBundleById(
    bundleId: string,
    newBundle: Partial<Bundle>,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
  deleteBundleById(
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<void>;
}

export type StoragePluginFactory<TContext = unknown> =
  () => StoragePlugin<TContext>;

import type { Bundle, NativeBuild } from "@hot-updater/core";
import { memoize, merge } from "es-toolkit";
import type {
  BasePluginArgs,
  DatabasePlugin,
  DatabasePluginHooks,
  PaginationInfo,
} from "./types";

export interface BaseDatabaseUtils {
  cwd: string;
}

export interface AbstractDatabasePlugin<TContext = object> {
  getContext?: () => TContext;
  getBundleById: (
    context: TContext,
    bundleId: string,
  ) => Promise<Bundle | null>;
  getBundles: (
    context: TContext,
    options: {
      where?: { channel?: string; platform?: string };
      limit: number;
      offset: number;
    },
  ) => Promise<{
    data: Bundle[];
    pagination: PaginationInfo;
  }>;
  getChannels: (context: TContext) => Promise<string[]>;
  onUnmount?: (context: TContext) => void;
  commitBundle: (
    context: TContext,
    {
      changedSets,
    }: {
      changedSets: {
        operation: "insert" | "update" | "delete";
        data: Bundle;
      }[];
    },
  ) => Promise<void>;

  // Native build operations
  getNativeBuildById: (
    context: TContext,
    nativeBuildId: string,
  ) => Promise<NativeBuild | null>;
  getNativeBuilds: (
    context: TContext,
    options: {
      where?: { channel?: string; platform?: string; nativeVersion?: string };
      limit: number;
      offset: number;
    },
  ) => Promise<{
    data: NativeBuild[];
    pagination: PaginationInfo;
  }>;
  updateNativeBuild: (
    context: TContext,
    targetNativeBuildId: string,
    newNativeBuild: Partial<NativeBuild>,
  ) => Promise<void>;
  appendNativeBuild: (
    context: TContext,
    insertNativeBuild: NativeBuild,
  ) => Promise<void>;
  deleteNativeBuild: (
    context: TContext,
    deleteNativeBuild: NativeBuild,
  ) => Promise<void>;
}

/**
 * Creates a database plugin with the given implementation.
 *
 * @example
 * ```ts
 * const myDatabasePlugin = createDatabasePlugin("myDatabase", {
 *   getContext: () => ({
 *     // Your database client or connection
 *     dbClient: createDbClient()
 *   }),
 *   async getBundleById(context, bundleId) {
 *     // Implementation to get a bundle by ID using context.dbClient
 *     return bundle;
 *   },
 *   async getBundles(context, options) {
 *     // Implementation to get bundles with options using context.dbClient
 *     return bundles;
 *   },
 *   async getChannels(context) {
 *     // Implementation to get available channels using context.dbClient
 *     return channels;
 *   },
 *   async commitBundle(context, { changedSets }) {
 *     // Implementation to commit changed bundles using context.dbClient
 *   }
 * });
 * ```
 *
 * @param name - The name of the database plugin
 * @param abstractPlugin - A plugin implementation with context support
 * @param hooks - Optional hooks for plugin lifecycle events
 * @returns A function that creates a database plugin instance
 */
export function createDatabasePlugin<TContext = object>(
  name: string,
  abstractPlugin: AbstractDatabasePlugin<TContext>,
  hooks?: DatabasePluginHooks,
): (options: BasePluginArgs) => DatabasePlugin {
  const changedMap = new Map<
    string,
    {
      operation: "insert" | "update" | "delete";
      data: Bundle;
    }
  >();

  const markChanged = (
    operation: "insert" | "update" | "delete",
    data: Bundle,
  ) => {
    changedMap.set(data.id, { operation, data });
  };

  const memoizedContext = memoize(
    abstractPlugin?.getContext ?? ((() => {}) as () => TContext),
  );
  return (_: BasePluginArgs) => ({
    name,

    async getBundleById(bundleId: string) {
      const context = memoizedContext();
      return abstractPlugin.getBundleById(context, bundleId);
    },

    async getBundles(options) {
      const context = memoizedContext();
      return abstractPlugin.getBundles(context, options);
    },

    async getChannels() {
      const context = memoizedContext();
      return abstractPlugin.getChannels(context);
    },

    async commitBundle() {
      if (!abstractPlugin.commitBundle) {
        throw new Error("commitBundle is not implemented");
      }
      const context = memoizedContext();
      await abstractPlugin.commitBundle(context, {
        changedSets: Array.from(changedMap.values()),
      });
      changedMap.clear();
      hooks?.onDatabaseUpdated?.();
    },

    async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
      const pendingChange = changedMap.get(targetBundleId);
      if (pendingChange) {
        const updatedData = merge(pendingChange.data, newBundle);
        changedMap.set(targetBundleId, {
          operation: pendingChange.operation,
          data: updatedData,
        });
        return;
      }

      const currentBundle = await this.getBundleById(targetBundleId);
      if (!currentBundle) {
        throw new Error("targetBundleId not found");
      }

      const updatedBundle = merge(currentBundle, newBundle);
      markChanged("update", updatedBundle);
    },

    async appendBundle(inputBundle: Bundle) {
      markChanged("insert", inputBundle);
    },

    onUnmount: abstractPlugin.onUnmount
      ? async () => {
          const context = memoizedContext();
          await abstractPlugin.onUnmount?.(context);
        }
      : undefined,

    async deleteBundle(deleteBundle: Bundle): Promise<void> {
      markChanged("delete", deleteBundle);
    },

    // Native build operations
    async getNativeBuildById(nativeBuildId: string) {
      const context = memoizedContext();
      return abstractPlugin.getNativeBuildById(context, nativeBuildId);
    },

    async getNativeBuilds(options) {
      const context = memoizedContext();
      return abstractPlugin.getNativeBuilds(context, options);
    },

    async updateNativeBuild(
      targetNativeBuildId: string,
      newNativeBuild: Partial<NativeBuild>,
    ) {
      const context = memoizedContext();
      return abstractPlugin.updateNativeBuild(
        context,
        targetNativeBuildId,
        newNativeBuild,
      );
    },

    async appendNativeBuild(insertNativeBuild: NativeBuild) {
      const context = memoizedContext();
      return abstractPlugin.appendNativeBuild(context, insertNativeBuild);
    },

    async deleteNativeBuild(deleteNativeBuild: NativeBuild) {
      const context = memoizedContext();
      return abstractPlugin.deleteNativeBuild(context, deleteNativeBuild);
    },
  });
}

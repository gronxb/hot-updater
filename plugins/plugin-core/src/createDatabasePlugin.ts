import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { mergeWith } from "es-toolkit";

import type {
  DatabaseBundleQueryOptions,
  DatabasePlugin,
  DatabasePluginHooks,
  HotUpdaterContext,
  Paginated,
} from "./types";

export interface AbstractDatabasePlugin<TContext = unknown> {
  getBundleById: (
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle | null>;
  getUpdateInfo?: (
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<UpdateInfo | null>;
  getBundles: (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Paginated<Bundle[]>>;
  getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
  onUnmount?: () => Promise<void>;
  commitBundle: (
    params: {
      changedSets: {
        operation: "insert" | "update" | "delete";
        data: Bundle;
      }[];
    },
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
}

/**
 * Database plugin methods without name
 */
type DatabasePluginMethods<TContext = unknown> = Omit<
  AbstractDatabasePlugin<TContext>,
  never
>;

/**
 * Factory function that creates database plugin methods
 */
type DatabasePluginFactory<TConfig, TContext = unknown> = (
  config: TConfig,
) => DatabasePluginMethods<TContext>;

const REPLACE_ON_UPDATE_KEYS = ["targetCohorts"] as const;

function mergeBundleUpdate(baseBundle: Bundle, patch: Partial<Bundle>): Bundle {
  return mergeWith(baseBundle, patch, (_targetValue, sourceValue, key) => {
    if (
      REPLACE_ON_UPDATE_KEYS.includes(
        key as (typeof REPLACE_ON_UPDATE_KEYS)[number],
      )
    ) {
      return sourceValue;
    }

    return undefined;
  });
}

/**
 * Configuration options for creating a database plugin
 */
export interface CreateDatabasePluginOptions<TConfig, TContext = unknown> {
  /**
   * The name of the database plugin (e.g., "postgres", "d1Database")
   */
  name: string;
  /**
   * Function that creates the database plugin methods
   */
  factory: DatabasePluginFactory<TConfig, TContext>;
}

/**
 * Creates a database plugin with lazy initialization and automatic hook execution.
 *
 * This factory function abstracts the double currying pattern used by all database plugins,
 * ensuring consistent lazy initialization behavior across different database providers.
 * Hooks are automatically executed at appropriate times without requiring manual invocation.
 *
 * @param options - Configuration options for the database plugin
 * @returns A double-curried function that lazily initializes the database plugin
 *
 * @example
 * ```typescript
 * export const postgres = createDatabasePlugin<PostgresConfig>({
 *   name: "postgres",
 *   factory: (config) => {
 *     const db = new Kysely(config);
 *     return {
 *       async getBundleById(bundleId) { ... },
 *       async getBundles(options) { ... },
 *       async getChannels() { ... },
 *       async commitBundle({ changedSets }) { ... }
 *     };
 *   }
 * });
 * ```
 */
export function createDatabasePlugin<TConfig, TContext = unknown>(
  options: CreateDatabasePluginOptions<TConfig, TContext>,
) {
  return (
    config: TConfig,
    hooks?: DatabasePluginHooks,
  ): (() => DatabasePlugin<TContext>) => {
    // Share the underlying plugin methods for a configured factory while
    // keeping each returned DatabasePlugin instance's pending changes isolated.
    let cachedMethods: DatabasePluginMethods<TContext> | null = null;
    const getMethods = () => {
      if (!cachedMethods) {
        cachedMethods = options.factory(config);
      }
      return cachedMethods;
    };

    return (): DatabasePlugin<TContext> => {
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

      const plugin: DatabasePlugin<TContext> = {
        name: options.name,

        async getBundleById(bundleId: string, context) {
          if (context === undefined) {
            return getMethods().getBundleById(bundleId);
          }

          return getMethods().getBundleById(bundleId, context);
        },

        async getBundles(options, context) {
          if (context === undefined) {
            return getMethods().getBundles(options);
          }

          return getMethods().getBundles(options, context);
        },

        async getChannels(context) {
          if (context === undefined) {
            return getMethods().getChannels();
          }

          return getMethods().getChannels(context);
        },

        async onUnmount() {
          const methods = getMethods();
          if (methods.onUnmount) {
            return methods.onUnmount();
          }
        },

        async commitBundle(context) {
          const methods = getMethods();
          const params = {
            changedSets: Array.from(changedMap.values()),
          };

          if (context === undefined) {
            await methods.commitBundle(params);
          } else {
            await methods.commitBundle(params, context);
          }

          changedMap.clear();
          await hooks?.onDatabaseUpdated?.();
        },

        async updateBundle(
          targetBundleId: string,
          newBundle: Partial<Bundle>,
          context,
        ) {
          const pendingChange = changedMap.get(targetBundleId);
          if (pendingChange) {
            const updatedData = mergeBundleUpdate(
              pendingChange.data,
              newBundle,
            );
            changedMap.set(targetBundleId, {
              operation: pendingChange.operation,
              data: updatedData,
            });
            return;
          }

          const currentBundle =
            context === undefined
              ? await getMethods().getBundleById(targetBundleId)
              : await getMethods().getBundleById(targetBundleId, context);
          if (!currentBundle) {
            throw new Error("targetBundleId not found");
          }

          const updatedBundle = mergeBundleUpdate(currentBundle, newBundle);
          markChanged("update", updatedBundle);
        },

        async appendBundle(inputBundle: Bundle) {
          markChanged("insert", inputBundle);
        },

        async deleteBundle(deleteBundle: Bundle): Promise<void> {
          markChanged("delete", deleteBundle);
        },
      };

      Object.defineProperty(plugin, "getUpdateInfo", {
        configurable: true,
        enumerable: true,
        get() {
          const methods = getMethods();
          const directGetUpdateInfo = methods.getUpdateInfo;

          if (!directGetUpdateInfo) {
            Object.defineProperty(plugin, "getUpdateInfo", {
              configurable: true,
              enumerable: true,
              value: undefined,
            });
            return undefined;
          }

          const wrappedGetUpdateInfo: NonNullable<
            DatabasePlugin<TContext>["getUpdateInfo"]
          > = async (args, context) => {
            if (context === undefined) {
              return directGetUpdateInfo(args);
            }

            return directGetUpdateInfo(args, context);
          };

          Object.defineProperty(plugin, "getUpdateInfo", {
            configurable: true,
            enumerable: true,
            value: wrappedGetUpdateInfo,
          });
          return wrappedGetUpdateInfo;
        },
      });

      return plugin;
    };
  };
}

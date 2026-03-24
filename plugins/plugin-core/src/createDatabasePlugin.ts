import type { Bundle } from "@hot-updater/core";
import { mergeWith } from "es-toolkit";
import type {
  DatabaseBundleQueryOptions,
  DatabasePlugin,
  DatabasePluginHooks,
  HotUpdaterContext,
  PaginationInfo,
} from "./types";

export interface AbstractDatabasePlugin<TEnv = unknown> {
  getBundleById: (
    bundleId: string,
    context?: HotUpdaterContext<TEnv>,
  ) => Promise<Bundle | null>;
  getBundles: (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TEnv>,
  ) => Promise<{
    data: Bundle[];
    pagination: PaginationInfo;
  }>;
  getChannels: (context?: HotUpdaterContext<TEnv>) => Promise<string[]>;
  onUnmount?: () => Promise<void>;
  commitBundle: (
    params: {
      changedSets: {
        operation: "insert" | "update" | "delete";
        data: Bundle;
      }[];
    },
    context?: HotUpdaterContext<TEnv>,
  ) => Promise<void>;
}

/**
 * Database plugin methods without name
 */
type DatabasePluginMethods<TEnv = unknown> = Omit<
  AbstractDatabasePlugin<TEnv>,
  never
>;

/**
 * Factory function that creates database plugin methods
 */
type DatabasePluginFactory<TConfig, TEnv = unknown> = (
  config: TConfig,
) => DatabasePluginMethods<TEnv>;

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
export interface CreateDatabasePluginOptions<TConfig, TEnv = unknown> {
  /**
   * The name of the database plugin (e.g., "postgres", "d1Database")
   */
  name: string;
  /**
   * Function that creates the database plugin methods
   */
  factory: DatabasePluginFactory<TConfig, TEnv>;
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
export function createDatabasePlugin<TConfig, TEnv = unknown>(
  options: CreateDatabasePluginOptions<TConfig, TEnv>,
) {
  return (
    config: TConfig,
    hooks?: DatabasePluginHooks,
  ): (() => DatabasePlugin<TEnv>) => {
    return (): DatabasePlugin<TEnv> => {
      // Lazy initialization: factory is only called on first method invocation
      let cachedMethods: DatabasePluginMethods<TEnv> | null = null;
      const getMethods = () => {
        if (!cachedMethods) {
          cachedMethods = options.factory(config);
        }
        return cachedMethods;
      };

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

      return {
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

          await hooks?.onDatabaseUpdated?.();
          changedMap.clear();
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
    };
  };
}

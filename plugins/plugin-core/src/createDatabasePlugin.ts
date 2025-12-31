import type { Bundle } from "@hot-updater/core";
import { merge } from "es-toolkit";
import type {
  DatabasePlugin,
  DatabasePluginHooks,
  PaginationInfo,
} from "./types";

export interface AbstractDatabasePlugin {
  getBundleById: (bundleId: string) => Promise<Bundle | null>;
  getBundles: (options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }) => Promise<{
    data: Bundle[];
    pagination: PaginationInfo;
  }>;
  getChannels: () => Promise<string[]>;
  onUnmount?: () => Promise<void>;
  commitBundle: (params: {
    changedSets: {
      operation: "insert" | "update" | "delete";
      data: Bundle;
    }[];
  }) => Promise<void>;
}

/**
 * Database plugin methods without name
 */
type DatabasePluginMethods = Omit<AbstractDatabasePlugin, never>;

/**
 * Factory function that creates database plugin methods
 */
type DatabasePluginFactory<TConfig> = (
  config: TConfig,
) => DatabasePluginMethods;

/**
 * Configuration options for creating a database plugin
 */
export interface CreateDatabasePluginOptions<TConfig> {
  /**
   * The name of the database plugin (e.g., "postgres", "d1Database")
   */
  name: string;
  /**
   * Function that creates the database plugin methods
   */
  factory: DatabasePluginFactory<TConfig>;
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
export function createDatabasePlugin<TConfig>(
  options: CreateDatabasePluginOptions<TConfig>,
) {
  return (
    config: TConfig,
    hooks?: DatabasePluginHooks,
  ): (() => DatabasePlugin) => {
    return (): DatabasePlugin => {
      // Lazy initialization: factory is only called on first method invocation
      let cachedMethods: DatabasePluginMethods | null = null;
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

        async getBundleById(bundleId: string) {
          return getMethods().getBundleById(bundleId);
        },

        async getBundles(options) {
          return getMethods().getBundles(options);
        },

        async getChannels() {
          return getMethods().getChannels();
        },

        async onUnmount() {
          const methods = getMethods();
          if (methods.onUnmount) {
            return methods.onUnmount();
          }
        },

        async commitBundle() {
          const methods = getMethods();
          await methods.commitBundle({
            changedSets: Array.from(changedMap.values()),
          });
          await hooks?.onDatabaseUpdated?.();
          changedMap.clear();
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

          const currentBundle =
            await getMethods().getBundleById(targetBundleId);
          if (!currentBundle) {
            throw new Error("targetBundleId not found");
          }

          const updatedBundle = merge(currentBundle, newBundle);
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

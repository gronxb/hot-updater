import type { Bundle } from "@hot-updater/core";
import { merge } from "es-toolkit";
import type {
  BasePluginArgs,
  DatabasePlugin,
  DatabasePluginHooks,
} from "./types";

export interface BaseDatabaseUtils {
  cwd: string;
}

export interface AbstractDatabasePlugin
  extends Pick<
    DatabasePlugin,
    "getBundleById" | "getBundles" | "getChannels" | "onUnmount"
  > {
  commitBundle: ({
    changedSets,
  }: {
    changedSets: {
      operation: "insert" | "update" | "delete";
      data: Bundle;
    }[];
  }) => Promise<void>;
}

/**
 * Creates a database plugin with the given implementation.
 *
 * @example
 * ```ts
 * const myDatabasePlugin = createDatabasePlugin("myDatabase", (utils) => {
 *   return {
 *     async getBundleById(bundleId) {
 *       // Implementation to get a bundle by ID
 *       return bundle;
 *     },
 *     async getBundles(options) {
 *       // Implementation to get bundles with options
 *       return bundles;
 *     },
 *     async getChannels() {
 *       // Implementation to get available channels
 *       return channels;
 *     },
 *     async commitBundle({ changedMap }) {
 *       // Implementation to commit changed bundles
 *     }
 *   };
 * });
 * ```
 *
 * @param name - The name of the database plugin
 * @param initializer - A function that initializes the database plugin implementation
 * @returns A function that creates a database plugin instance
 */
export function createDatabasePlugin(
  name: string,
  abstractPlugin: AbstractDatabasePlugin,
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

  return (_: BasePluginArgs) => ({
    name,
    ...abstractPlugin,
    async commitBundle() {
      if (!abstractPlugin.commitBundle) {
        throw new Error("commitBundle is not implemented");
      }
      await abstractPlugin.commitBundle({
        changedSets: Array.from(changedMap.values()),
      });
      changedMap.clear();
      hooks?.onDatabaseUpdated?.();
    },
    async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
      const pendingChange = changedMap.get(targetBundleId);
      if (pendingChange && pendingChange.operation === "insert") {
        const updatedData = merge(pendingChange.data, newBundle);
        changedMap.set(targetBundleId, {
          operation: "insert",
          data: updatedData,
        });
        return;
      }

      const currentBundle = await abstractPlugin.getBundleById(targetBundleId);
      if (!currentBundle) {
        throw new Error("targetBundleId not found");
      }

      const updatedBundle = merge(currentBundle, newBundle);
      markChanged("update", updatedBundle);
    },
    async appendBundle(inputBundle: Bundle) {
      markChanged("insert", inputBundle);
    },
  });
}

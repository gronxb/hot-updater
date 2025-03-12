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
  extends Pick<DatabasePlugin, "getBundleById" | "getBundles" | "getChannels"> {
  commitBundle: ({
    changedSets,
  }: {
    changedSets: Set<{
      operation: "insert" | "update" | "delete";
      data: Bundle;
    }>;
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
 *     async commitBundle({ changedSets }) {
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
  const changedSets = new Set<{
    operation: "insert" | "update" | "delete";
    data: Bundle;
  }>();

  const markChanged = (
    operation: "insert" | "update" | "delete",
    data: Bundle,
  ) => {
    changedSets.add({ operation, data });
  };

  return (_: BasePluginArgs) => ({
    name,
    ...abstractPlugin,
    async commitBundle() {
      if (!abstractPlugin.commitBundle) {
        throw new Error("commitBundle is not implemented");
      }
      await abstractPlugin.commitBundle({ changedSets });
      changedSets.clear();
      hooks?.onDatabaseUpdated?.();
    },
    async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
      const currentBundle = await this.getBundleById(targetBundleId);
      if (!currentBundle) {
        throw new Error("target bundle version not found");
      }
      const updatedBundle = merge(currentBundle, newBundle);
      markChanged("update", updatedBundle);
    },
    async appendBundle(inputBundle: Bundle) {
      markChanged("insert", inputBundle);
    },
  });
}

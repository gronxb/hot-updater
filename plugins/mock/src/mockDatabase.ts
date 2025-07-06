import {
  type Bundle,
  type DatabasePluginHooks,
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = (
  config: MockDatabaseConfig,
  hooks?: DatabasePluginHooks,
) =>
  createDatabasePlugin(
    "mockDatabase",
    {
      getContext: () => {
        const bundles: Bundle[] = config.initialBundles ?? [];
        return { bundles };
      },

      async getBundleById(context, bundleId) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return context.bundles.find((b) => b.id === bundleId) ?? null;
      },

      async getBundles(context, options) {
        const { where, limit, offset } = options ?? {};
        await sleep(minMax(config.latency.min, config.latency.max));

        const filteredBundles = context.bundles.filter((b) => {
          if (where?.channel && b.channel !== where.channel) {
            return false;
          }
          if (where?.platform && b.platform !== where.platform) {
            return false;
          }
          return true;
        });

        const total = filteredBundles.length;
        const data = limit
          ? filteredBundles.slice(offset, offset + limit)
          : filteredBundles;
        const pagination = calculatePagination(total, { limit, offset });

        return {
          data,
          pagination,
        };
      },

      async getChannels(context) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return context.bundles
          .map((b) => b.channel)
          .filter((c, i, self) => self.indexOf(c) === i);
      },

      async commitBundle(context, { changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await sleep(minMax(config.latency.min, config.latency.max));

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            const targetIndex = context.bundles.findIndex(
              (b) => b.id === op.data.id,
            );
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            context.bundles.splice(targetIndex, 1);
          } else if (op.operation === "insert") {
            context.bundles.unshift(op.data);
          } else if (op.operation === "update") {
            const targetIndex = context.bundles.findIndex(
              (b) => b.id === op.data.id,
            );
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            Object.assign(context.bundles[targetIndex], op.data);
          }
        }

        // Trigger hooks after all operations
        hooks?.onDatabaseUpdated?.();
      },

      // Native build operations
      async getNativeBuildById(context, nativeBuildId: string) {
        return null; // Mock implementation returns null
      },

      async getNativeBuilds(context, options) {
        return {
          data: [],
          pagination: {
            offset: 0,
            limit: options.limit,
            total: 0,
            totalPages: 0,
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      },

      async updateNativeBuild(
        context,
        targetNativeBuildId: string,
        newNativeBuild,
      ) {
        // Mock implementation does nothing
      },

      async appendNativeBuild(context, insertNativeBuild) {
        // Mock implementation does nothing
      },

      async deleteNativeBuild(context, deleteNativeBuild) {
        // Mock implementation does nothing
      },
    },
    hooks,
  );

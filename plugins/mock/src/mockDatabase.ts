import {
  type Bundle,
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase = createDatabasePlugin<MockDatabaseConfig>({
  name: "mockDatabase",
  factory: (config) => {
    const bundles: Bundle[] = config.initialBundles ?? [];

    return {
      async getBundleById(bundleId: string) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles.find((b) => b.id === bundleId) ?? null;
      },

      async getBundles(options) {
        const { where, limit, offset } = options ?? {};
        await sleep(minMax(config.latency.min, config.latency.max));

        const filteredBundles = bundles.filter((b) => {
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

      async getChannels() {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles
          .map((b) => b.channel)
          .filter((c, i, self) => self.indexOf(c) === i);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await sleep(minMax(config.latency.min, config.latency.max));

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            bundles.splice(targetIndex, 1);
          } else if (op.operation === "insert") {
            bundles.unshift(op.data);
          } else if (op.operation === "update") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            Object.assign(bundles[targetIndex], op.data);
          }
        }
      },
    };
  },
});

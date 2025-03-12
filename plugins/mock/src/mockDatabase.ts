import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
}

export const mockDatabase =
  (config: MockDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const bundles: Bundle[] = config.initialBundles ?? [];
    const latency = config.latency;

    return {
      name: "mockDatabase",
      async commitBundle() {
        await sleep(minMax(latency.min, latency.max));
        await hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        await sleep(minMax(latency.min, latency.max));
        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }
        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle: Bundle) {
        await sleep(minMax(latency.min, latency.max));
        bundles.unshift(inputBundle);
      },
      async getBundleById(bundleId: string) {
        await sleep(minMax(latency.min, latency.max));
        return bundles.find((b) => b.id === bundleId) ?? null;
      },
      async getBundles(options) {
        const { where, limit, offset = 0 } = options ?? {};

        await sleep(minMax(latency.min, latency.max));
        const filteredBundles = bundles.filter((b) => {
          if (where?.channel && b.channel !== where.channel) {
            return false;
          }
          if (where?.platform && b.platform !== where.platform) {
            return false;
          }
          return true;
        });
        if (limit) {
          return filteredBundles.slice(offset, offset + limit);
        }
        return filteredBundles;
      },
      async getChannels() {
        await sleep(minMax(latency.min, latency.max));
        return bundles
          .map((b) => b.channel)
          .filter((c, i, self) => self.indexOf(c) === i);
      },
    };
  };

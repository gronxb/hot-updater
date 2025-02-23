import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { sleepMaxLimit } from "./util/utils";

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
        await sleepMaxLimit(latency.min, latency.max);
        await hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        await sleepMaxLimit(latency.min, latency.max);
        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }
        Object.assign(bundles[targetIndex], newBundle);
        await hooks?.onDatabaseUpdated?.();
      },
      async appendBundle(inputBundle: Bundle) {
        await sleepMaxLimit(latency.min, latency.max);
        bundles.unshift(inputBundle);
        await hooks?.onDatabaseUpdated?.();
      },
      async getBundleById(bundleId: string) {
        await sleepMaxLimit(latency.min, latency.max);
        return (await bundles.find((b) => b.id === bundleId)) ?? null;
      },
      async getBundles() {
        await sleepMaxLimit(latency.min, latency.max);
        return await bundles.sort((a, b) => a.id.localeCompare(b.id));
      },
    };
  };

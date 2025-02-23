import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { sleepMaxLimit } from "./util/utils";

export interface MockDatabaseConfig {
  initialBundles?: Bundle[];
  maxLatency: number;
}

export const mockDatabase =
  (config: MockDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const bundles: Bundle[] = config.initialBundles ?? [];
    const maxLatency = config.maxLatency ?? 1000;
    return {
      name: "mockDatabase",
      async commitBundle() {
        await sleepMaxLimit(maxLatency).then(() => {
          hooks?.onDatabaseUpdated?.();
        });
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        await sleepMaxLimit(maxLatency);
        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }
        Object.assign(bundles[targetIndex], newBundle);
        await hooks?.onDatabaseUpdated?.();
      },
      async appendBundle(inputBundle: Bundle) {
        await sleepMaxLimit(maxLatency);
        bundles.unshift(inputBundle);
        await hooks?.onDatabaseUpdated?.();
      },
      async getBundleById(bundleId: string) {
        let result: Bundle | null = null;
        await sleepMaxLimit(maxLatency);
        result = bundles.find((b) => b.id === bundleId) ?? null;
        return await result;
      },
      async getBundles() {
        let result: Bundle[] = [];
        await sleepMaxLimit(maxLatency);
        result = bundles.sort((a, b) => a.id.localeCompare(b.id));
        return await result;
      },
    };
  };

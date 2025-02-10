import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

export interface MockDatabaseConfig {
  initialBundles?: Bundle[];
}

export const mockDatabase =
  (config: MockDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const bundles: Bundle[] = config.initialBundles ?? [];

    return {
      name: "mockDatabase",
      async commitBundle() {
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }
        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle: Bundle) {
        bundles.unshift(inputBundle);
      },
      async getBundleById(bundleId: string) {
        return bundles.find((b) => b.id === bundleId) ?? null;
      },
      async getBundles() {
        return bundles.sort((a, b) => a.id.localeCompare(b.id));
      },
    };
  };

import { createMockDatabaseData, mockDatabase } from "@hot-updater/mock";
import type { Bundle } from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { vi } from "vitest";

export const createDatabasePluginHarness = () => {
  const data = createMockDatabaseData();
  const basePlugin = mockDatabase({ data, latency: { min: 0, max: 0 } });
  const read = vi.fn(async (): Promise<void> => {});
  const commit = vi.fn((input) => basePlugin.commit(input));
  const dispose = vi.fn(async (): Promise<void> => {});
  const plugin: DatabasePlugin = {
    name: "test-database-v2",
    bundles: {
      async findById(id) {
        await read();
        return basePlugin.bundles.findById(id);
      },
      async findMany(query) {
        await read();
        return basePlugin.bundles.findMany(query);
      },
      async count(where) {
        await read();
        return basePlugin.bundles.count(where);
      },
    },
    bundlePatches: {
      async findByBundleIds(bundleIds) {
        await read();
        return basePlugin.bundlePatches.findByBundleIds(bundleIds);
      },
    },
    analytics: basePlugin.analytics,
    clientAccessKeys: basePlugin.clientAccessKeys,
    commit,
    async getChannels() {
      await read();
      return basePlugin.getChannels?.() ?? [];
    },
    async getUpdateInfo(args) {
      await read();
      return basePlugin.getUpdateInfo?.(args) ?? null;
    },
    dispose,
  };

  return {
    plugin,
    commit,
    read,
    dispose,
    bundles: async (): Promise<Bundle[]> =>
      (
        await createDatabaseClient(plugin).getBundles({
          limit: 100,
        })
      ).data,
    reset: (): void => {
      data.bundles.clear();
      data.bundlePatches.clear();
      data.bundleEvents.clear();
      data.clientAccessKeys.clear();
      read.mockReset().mockResolvedValue(undefined);
      commit
        .mockReset()
        .mockImplementation((input) => basePlugin.commit(input));
    },
    setBundles: (bundles: readonly Bundle[]): void => {
      data.bundles.clear();
      data.bundlePatches.clear();
      for (const bundle of bundles) {
        data.bundles.set(bundle.id, bundleToRow(bundle));
        for (const patch of bundleToPatchRows(bundle)) {
          data.bundlePatches.set(patch.id, patch);
        }
      }
    },
  };
};

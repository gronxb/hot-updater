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
    models: {
      bundles: {
        async findById(id) {
          await read();
          return basePlugin.models.bundles.findById(id);
        },
        async findMany(query) {
          await read();
          return basePlugin.models.bundles.findMany(query);
        },
        async count(where) {
          await read();
          return basePlugin.models.bundles.count(where);
        },
      },
      bundlePatches: {
        async findByBundleIds(bundleIds) {
          await read();
          return basePlugin.models.bundlePatches.findByBundleIds(bundleIds);
        },
      },
      channels: {
        insert: (input) => basePlugin.models.channels.insert(input),
        async list(input) {
          await read();
          return basePlugin.models.channels.list(input);
        },
        delete: (input) => basePlugin.models.channels.delete(input),
      },
      analytics: basePlugin.models.analytics,
      clientAccessKeys: basePlugin.models.clientAccessKeys,
    },
    queries: {
      async getUpdateInfo(args) {
        await read();
        return basePlugin.queries.getUpdateInfo?.(args) ?? null;
      },
    },
    commit,
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
      data.channels.clear();
      data.clientAccessKeys.clear();
      read.mockReset().mockResolvedValue(undefined);
      commit
        .mockReset()
        .mockImplementation((input) => basePlugin.commit(input));
    },
    setBundles: (bundles: readonly Bundle[]): void => {
      data.bundles.clear();
      data.bundlePatches.clear();
      data.channels.clear();
      const channels = [...new Set(bundles.map(({ channel }) => channel))].map(
        (name) => ({ id: `channel-${name}`, name }),
      );
      const channelIds = new Map(channels.map(({ id, name }) => [name, id]));
      for (const channel of channels) data.channels.set(channel.id, channel);
      for (const bundle of bundles) {
        data.bundles.set(
          bundle.id,
          bundleToRow(bundle, channelIds.get(bundle.channel)!),
        );
        for (const patch of bundleToPatchRows(bundle)) {
          data.bundlePatches.set(patch.id, patch);
        }
      }
    },
  };
};

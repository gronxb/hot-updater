import { createMockDatabaseData, mockDatabase } from "@hot-updater/mock";
import type { Bundle, LegacyBundle } from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { compileLegacyReleaseCatalogBackfill } from "@hot-updater/server";
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
      releases: {
        async findById(id) {
          await read();
          return basePlugin.models.releases.findById(id);
        },
        async findMany(input) {
          await read();
          return basePlugin.models.releases.findMany(input);
        },
        async findManyByScope(input) {
          await read();
          return basePlugin.models.releases.findManyByScope(input);
        },
      },
      releaseCatalogs: {
        async findByScopeKey(scopeKey) {
          await read();
          return basePlugin.models.releaseCatalogs.findByScopeKey(scopeKey);
        },
        async findMany(input) {
          await read();
          return basePlugin.models.releaseCatalogs.findMany(input);
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
    commit,
    dispose,
  };

  const setBundles = (bundles: readonly LegacyBundle[]): void => {
    data.bundles.clear();
    data.bundlePatches.clear();
    data.channels.clear();
    data.releaseCatalogs.clear();
    data.releases.clear();
    const channels = [...new Set(bundles.map(({ channel }) => channel))].map(
      (name) => ({ id: `channel-${name}`, name }),
    );
    for (const channel of channels) data.channels.set(channel.id, channel);
    for (const bundle of bundles) {
      data.bundles.set(bundle.id, bundleToRow(bundle));
      for (const patch of bundleToPatchRows(bundle)) {
        data.bundlePatches.set(patch.id, patch);
      }
    }
    return;
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
    releases: () =>
      plugin.models.releases.findMany({
        limit: 100,
      }),
    reset: (): void => {
      data.bundles.clear();
      data.bundlePatches.clear();
      data.bundleEvents.clear();
      data.channels.clear();
      data.clientAccessKeys.clear();
      data.releaseCatalogs.clear();
      data.releases.clear();
      read.mockReset().mockResolvedValue(undefined);
      commit
        .mockReset()
        .mockImplementation((input) => basePlugin.commit(input));
    },
    setBundles,
    seedLegacyBundles: async (
      bundles: readonly LegacyBundle[],
      authorityId = "default",
    ): Promise<void> => {
      setBundles(bundles);
      const channelIds = new Map(
        [...data.channels.values()].map(({ id, name }) => [name, id]),
      );
      const backfill = await compileLegacyReleaseCatalogBackfill({
        authorityId,
        rows: bundles.map((bundle) => ({
          id: bundle.id,
          platform: bundle.platform,
          channel: bundle.channel,
          enabled: bundle.enabled,
          should_force_update: bundle.shouldForceUpdate,
          message: bundle.message,
          target_app_version: bundle.targetAppVersion,
          fingerprint_hash: bundle.fingerprintHash,
          rollout_cohort_count: bundle.rolloutCohortCount,
          target_cohorts: bundle.targetCohorts,
        })),
      });
      for (const release of backfill.releases) {
        data.releases.set(release.row.id, {
          ...release.row,
          channel_id: channelIds.get(release.channelName)!,
        });
      }
      for (const catalog of backfill.catalogs) {
        data.releaseCatalogs.set(catalog.row.scope_key, {
          ...catalog.row,
          channel_id: channelIds.get(catalog.channelName)!,
        });
      }
    },
  };
};

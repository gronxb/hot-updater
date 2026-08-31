import type {
  DatabasePlugin,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";

type ReleaseCatalogTestState = DatabasePluginTestState<DatabasePlugin>;

const catalogRow = (
  scopeKey: string,
  channelId: string,
  generation: number,
): ReleaseCatalogRow => ({
  catalog_id: "test",
  byte_size: 2,
  catalog_hash: `sha256:generation-${generation}`,
  channel_id: channelId,
  channel_key: "cHJvZHVjdGlvbg",
  fingerprint_hash: null,
  generation,
  is_tombstone: false,
  payload: "{}",
  platform: "ios",
  scope_key: scopeKey,
  strategy: "APP_VERSION",
  updated_at_ms: generation,
});

export const registerDatabasePluginReleaseCatalogTests = (
  state: ReleaseCatalogTestState,
): void => {
  describe("Release catalog persistence", () => {
    it("provides canonical Release paging and exact catalog reads", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("production");
      const firstBundle = createBundleRowFixture("971");
      const secondBundle = createBundleRowFixture("972");
      const firstRelease = createReleaseRowFixture("971", firstBundle, channel);
      const secondRelease = {
        ...createReleaseRowFixture("972", secondBundle, channel),
        scope_key: firstRelease.scope_key,
      };
      const catalog = catalogRow(firstRelease.scope_key, channel.id, 1);

      await plugin.models.channels.insert({
        onConflict: "returnExisting",
        row: channel,
      });
      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "insert", row: firstBundle },
            { model: "bundles", operation: "insert", row: secondBundle },
            { model: "releases", operation: "insert", row: firstRelease },
            { model: "releases", operation: "insert", row: secondRelease },
            {
              model: "releaseCatalogs",
              operation: "put",
              row: catalog,
            },
          ],
          expectations: [
            {
              id: firstRelease.id,
              model: "releases",
              revision: null,
            },
            {
              id: secondRelease.id,
              model: "releases",
              revision: null,
            },
            {
              generation: null,
              model: "releaseCatalogs",
              scopeKey: catalog.scope_key,
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });

      await expect(
        plugin.models.releases.findManyByScope({
          consistency: "strong",
          limit: 1,
          scopeKey: firstRelease.scope_key,
        }),
      ).resolves.toEqual([firstRelease]);
      await expect(
        plugin.models.releases.findManyByScope({
          afterReleaseId: firstRelease.id,
          consistency: "strong",
          limit: 1,
          scopeKey: firstRelease.scope_key,
        }),
      ).resolves.toEqual([secondRelease]);
      await expect(
        plugin.models.releases.findMany({
          channelId: channel.id,
          limit: 10,
          platform: "ios",
          targetAppVersion: "1.0.0",
        }),
      ).resolves.toEqual([secondRelease, firstRelease]);
      await expect(
        plugin.models.releases.findMany({
          afterReleaseId: firstRelease.id,
          limit: 10,
        }),
      ).resolves.toEqual([secondRelease]);
      await expect(
        plugin.models.releases.findMany({
          limit: 10,
          targetAppVersion: "2.0.0",
        }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.releaseCatalogs.findByScopeKey(catalog.scope_key),
      ).resolves.toEqual(catalog);
      await expect(
        plugin.models.releaseCatalogs.findMany({ limit: 1 }),
      ).resolves.toEqual([catalog]);
    });

    it("rolls back Release and catalog writes on a stale expectation", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("stable");
      const bundle = createBundleRowFixture("973");
      const release = createReleaseRowFixture("973", bundle, channel);
      const firstCatalog = catalogRow(release.scope_key, channel.id, 1);

      await plugin.models.channels.insert({
        onConflict: "returnExisting",
        row: channel,
      });
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "releases", operation: "insert", row: release },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: firstCatalog,
          },
        ],
        expectations: [
          { id: release.id, model: "releases", revision: null },
          {
            generation: null,
            model: "releaseCatalogs",
            scopeKey: release.scope_key,
          },
        ],
      });

      const secondCatalog = catalogRow(release.scope_key, channel.id, 2);
      await expect(
        plugin.commit({
          changes: [
            {
              model: "releases",
              operation: "update",
              update: { revision: 2, updated_at_ms: 2 },
              where: { id: release.id },
            },
            {
              model: "releaseCatalogs",
              operation: "put",
              row: secondCatalog,
            },
          ],
          expectations: [
            { id: release.id, model: "releases", revision: 1 },
            {
              generation: 1,
              model: "releaseCatalogs",
              scopeKey: release.scope_key,
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });

      const staleResult = await plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "update",
            update: { revision: 3, updated_at_ms: 3 },
            where: { id: release.id },
          },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: catalogRow(release.scope_key, channel.id, 3),
          },
        ],
        expectations: [
          { id: release.id, model: "releases", revision: 1 },
          {
            generation: 1,
            model: "releaseCatalogs",
            scopeKey: release.scope_key,
          },
        ],
      });

      expect(staleResult).toMatchObject({
        committed: false,
        conflict: {
          actualVersion: 2,
          expectedVersion: 1,
          key: release.id,
          model: "releases",
          reason: "version_conflict",
        },
      });
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toMatchObject({ revision: 2, updated_at_ms: 2 });
      await expect(
        plugin.models.releaseCatalogs.findByScopeKey(release.scope_key),
      ).resolves.toEqual(secondCatalog);
    });
  });
};

import {
  type DatabasePlugin,
  type DatabaseChange,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleEventRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createApiKeyRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";

type CapabilityTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, ...changes: DatabaseChange[]) =>
  plugin.commit({ changes });

export const registerDatabasePluginCapabilityTests = (
  state: CapabilityTestState,
): void => {
  describe("database commit boundary", () => {
    it("does not expose callback transactions or superseded flat members", () => {
      const plugin = state.getPlugin();
      expect(Object.keys(plugin.models).sort()).toEqual(
        [
          "analytics",
          "bundlePatches",
          "bundles",
          "channels",
          "apiKeys",
          "releaseCatalogs",
          "releases",
        ].sort(),
      );
      expect(Reflect.has(plugin, "queries")).toBe(false);
      expect(Reflect.has(plugin, "transaction")).toBe(false);
      for (const member of [
        "bundles",
        "bundlePatches",
        "channels",
        "analytics",
        "apiKeys",
        "getChannels",
        "getUpdateInfo",
      ]) {
        expect(Reflect.has(plugin, member)).toBe(false);
      }
    });

    it("atomically inserts every official model", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("production");
      const base = createBundleRowFixture("86");
      const bundle = createBundleRowFixture("87");
      const patch = createBundlePatchRowFixture("87", bundle.id, base.id);
      const event = createBundleEventRowFixture("87", 100);
      const apiKey = createApiKeyRowFixture("87", 100);

      await expect(
        commit(
          plugin,
          {
            model: "channels",
            operation: "insert",
            row: channel,
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row: base },
          { model: "bundles", operation: "insert", row: bundle },
          { model: "bundlePatches", operation: "insert", row: patch },
          { model: "analytics", operation: "insert", row: event },
          {
            model: "apiKeys",
            operation: "insert",
            row: apiKey,
            onConflict: "ignore",
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(
        plugin.models.bundlePatches.findByBundleIds([bundle.id]),
      ).resolves.toEqual([patch]);
      await expect(
        plugin.models.analytics.scan({ beforeReceivedAtMs: 101, limit: 10 }),
      ).resolves.toEqual([event]);
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual(apiKey);
    });

    it("treats supported conflict-ignored inserts as idempotent", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("preview");
      const apiKey = createApiKeyRowFixture("88", 100);
      const changes = [
        {
          model: "channels",
          operation: "insert",
          row: channel,
          onConflict: "ignore",
        },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      ] as const satisfies readonly DatabaseChange[];

      await expect(plugin.commit({ changes })).resolves.toEqual({
        committed: true,
      });
      await expect(plugin.commit({ changes })).resolves.toEqual({
        committed: true,
      });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(plugin.models.apiKeys.list()).resolves.toEqual([apiKey]);
    });

    it("atomically updates bundle and API key models", async () => {
      const plugin = state.getPlugin();
      const bundle = createBundleRowFixture("89");
      const apiKey = createApiKeyRowFixture("89", 100);
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      );

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/89-updated.zip" },
          },
          {
            model: "apiKeys",
            operation: "update",
            where: { id: apiKey.id },
            update: { revokedAtMs: 200 },
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(bundle.id),
      ).resolves.toMatchObject({
        storage_uri: "storage://bundles/89-updated.zip",
      });
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual({ ...apiKey, revoked_at_ms: 200 });
    });

    it("accepts an empty atomic commit", async () => {
      await expect(state.getPlugin().commit({ changes: [] })).resolves.toEqual({
        committed: true,
      });
    });

    it("deletes an empty channel through the generic commit boundary", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("commit-delete");
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });

      await expect(
        commit(plugin, {
          model: "channels",
          operation: "delete",
          where: { id: channel.id },
        }),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("treats a missing generic channel delete as idempotent", async () => {
      await expect(
        commit(state.getPlugin(), {
          model: "channels",
          operation: "delete",
          where: { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
        }),
      ).resolves.toEqual({ committed: true });
    });

    it("deletes an artifact and an independent empty channel atomically", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("retired");
      const bundle = createBundleRowFixture("90", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "delete",
            where: { id: bundle.id },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(bundle.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("returns an indexed Release-referenced channel conflict and rolls back prior changes", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("protected");
      const bundle = createBundleRowFixture("96", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });
      const release = createReleaseRowFixture("96", bundle, channel);
      await commit(plugin, {
        model: "releases",
        operation: "insert",
        row: release,
      });

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/96-updated.zip" },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    });

    it("rolls back an atomic commit when a later mutation violates a relation", async () => {
      const plugin = state.getPlugin();
      const first = createBundleRowFixture("91");
      const second = createBundleRowFixture("92");
      const invalidPatch = createBundlePatchRowFixture(
        "93",
        second.id,
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      );
      const event = createBundleEventRowFixture("93", 100);
      const apiKey = createApiKeyRowFixture("93", 100);

      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: createChannelRowFixture("production"),
              onConflict: "ignore",
            },
            { model: "bundles", operation: "insert", row: first },
            { model: "bundles", operation: "insert", row: second },
            { model: "analytics", operation: "insert", row: event },
            {
              model: "apiKeys",
              operation: "insert",
              row: apiKey,
              onConflict: "ignore",
            },
            {
              model: "bundlePatches",
              operation: "insert",
              row: invalidPatch,
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundles.findById(first.id),
      ).resolves.toBeNull();
      await expect(
        plugin.models.bundles.findById(second.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
      await expect(
        plugin.models.analytics.scan({ beforeReceivedAtMs: 101, limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toBeNull();
    });

    it("rejects a Release that references a missing channel", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("production");
      const bundle = createBundleRowFixture("95");
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });
      const release = createReleaseRowFixture("95", bundle, channel);

      await expect(
        commit(plugin, {
          model: "releases",
          operation: "insert",
          row: release,
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toBeNull();
    });

    it("rolls back earlier changes when a later update conflicts", async () => {
      const plugin = state.getPlugin();
      const bundle = createBundleRowFixture("94");
      const apiKey = createApiKeyRowFixture("94", 100);
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      );

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/94-updated.zip" },
          },
          {
            model: "apiKeys",
            operation: "update",
            where: { id: "missing-key" },
            update: { revokedAtMs: 200 },
          },
        ),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "not_found" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual(apiKey);
    });
  });
};

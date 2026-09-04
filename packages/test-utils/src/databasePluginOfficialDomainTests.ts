import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundleEventRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createApiKeyRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";

type OfficialDomainTestState = DatabasePluginTestState<DatabasePlugin>;

export const registerDatabasePluginOfficialDomainTests = (
  state: OfficialDomainTestState,
): void => {
  describe("official database domains", () => {
    it("returns the canonical channel row under a concurrent name conflict", async () => {
      const plugin = state.getPlugin();
      const first = createChannelRowFixture("concurrent");
      const second = { ...first, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };

      const results = await Promise.all([
        plugin.models.channels.insert({
          row: first,
          onConflict: "returnExisting",
        }),
        plugin.models.channels.insert({
          row: second,
          onConflict: "returnExisting",
        }),
      ]);

      expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
      expect(results[0]?.row).toEqual(results[1]?.row);
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [results[0]!.row],
      });
    });

    it("rejects reusing a channel id for another name", async () => {
      const plugin = state.getPlugin();
      const first = createChannelRowFixture("first");
      await plugin.models.channels.insert({
        row: first,
        onConflict: "returnExisting",
      });

      await expect(
        plugin.models.channels.insert({
          row: { ...first, name: "second" },
          onConflict: "returnExisting",
        }),
      ).rejects.toThrow();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [first],
      });
    });

    it("deletes an empty channel and reports a missing channel", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("ephemeral");
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });

      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: true });
      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: false, reason: "not_found" });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("refuses to delete a Release-referenced channel and keeps both rows", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("referenced");
      const bundle = createBundleRowFixture("600", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          {
            model: "releases",
            operation: "insert",
            row: createReleaseRowFixture("600", bundle, channel),
          },
        ],
      });

      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: false, reason: "not_empty" });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
    });

    it("serializes channel deletion against a concurrent Release insert", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("race");
      const bundle = createBundleRowFixture("602", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row: bundle }],
      });
      const release = createReleaseRowFixture("602", bundle, channel);

      const [deletion, insertion] = await Promise.allSettled([
        plugin.models.channels.delete({ id: channel.id }),
        plugin.commit({
          changes: [{ model: "releases", operation: "insert", row: release }],
        }),
      ]);
      expect(deletion.status).toBe("fulfilled");

      const storedRelease = await plugin.models.releases.findById(release.id);
      const storedChannels = (await plugin.models.channels.list({})).channels;
      if (insertion.status === "fulfilled") {
        expect(insertion.value).toEqual({ committed: true });
        expect(deletion).toEqual({
          status: "fulfilled",
          value: { deleted: false, reason: "not_empty" },
        });
        expect(storedRelease).toEqual(release);
        expect(storedChannels).toEqual([channel]);
      } else {
        expect(deletion).toEqual({
          status: "fulfilled",
          value: { deleted: true },
        });
        expect(storedRelease).toBeNull();
        expect(storedChannels).toEqual([]);
      }
    });

    it("keeps an empty channel after its last Release is deleted", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("staging");
      const bundle = createBundleRowFixture("601", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          {
            model: "releases",
            operation: "insert",
            row: createReleaseRowFixture("601", bundle, channel),
          },
        ],
      });

      await plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "delete",
            where: { id: createReleaseRowFixture("601", bundle, channel).id },
          },
        ],
      });

      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    });

    it("lists channel rows by name", async () => {
      const plugin = state.getPlugin();
      const rows = [
        createChannelRowFixture("staging"),
        createChannelRowFixture("production"),
        createChannelRowFixture("beta"),
      ];
      for (const row of rows) {
        await plugin.models.channels.insert({
          row,
          onConflict: "returnExisting",
        });
      }

      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [rows[2], rows[1], rows[0]],
      });
    });

    it("appends and scans insights events in stable cursor order", async () => {
      const plugin = state.getPlugin();
      const first = createBundleEventRowFixture("701", 100);
      const second = createBundleEventRowFixture("702", 100);
      const third = createBundleEventRowFixture("703", 200);
      await plugin.models.insights.append(third);
      await plugin.models.insights.append(second);
      await plugin.models.insights.append(first);

      await expect(
        plugin.models.insights.scan({ beforeReceivedAtMs: 201, limit: 1 }),
      ).resolves.toEqual([first]);
      await expect(
        plugin.models.insights.scan({
          after: { receivedAtMs: first.received_at_ms, id: first.id },
          beforeReceivedAtMs: 201,
          limit: 1,
        }),
      ).resolves.toEqual([second]);
      await expect(
        plugin.models.insights.scan({
          after: { receivedAtMs: first.received_at_ms, id: first.id },
          beforeReceivedAtMs: 201,
          limit: 10,
        }),
      ).resolves.toEqual([second, third]);
      await expect(
        plugin.models.insights.scan({
          after: { receivedAtMs: second.received_at_ms, id: second.id },
          beforeReceivedAtMs: 200,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it("creates, lists, resolves, and revokes API keys", async () => {
      const plugin = state.getPlugin();
      const first = createApiKeyRowFixture("801", 100);
      const second = createApiKeyRowFixture("802", 200);

      await expect(plugin.models.apiKeys.create(first)).resolves.toBe(
        "created",
      );
      await expect(plugin.models.apiKeys.create(first)).resolves.toBe(
        "existing",
      );
      await expect(plugin.models.apiKeys.create(second)).resolves.toBe(
        "created",
      );
      await expect(
        plugin.models.apiKeys.findByHash(first.hash),
      ).resolves.toEqual(first);
      await expect(plugin.models.apiKeys.list()).resolves.toEqual([
        second,
        first,
      ]);
      await expect(
        plugin.models.apiKeys.revoke({
          id: first.id,
          revokedAtMs: 300,
        }),
      ).resolves.toEqual({ ...first, revoked_at_ms: 300 });
    });
  });
};

import { toInsightsInstallationRow } from "@hot-updater/plugin-core";
import type { BundleEventRow, DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundleEventRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createApiKeyRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";
import { expectInsightsIndex } from "./expectInsightsIndex";

type OfficialDomainTestState = DatabasePluginTestState<DatabasePlugin>;

const createMovementEvent = (
  suffix: string,
  receivedAtMs: number,
  type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED",
  installId: string,
): BundleEventRow => {
  const row = createBundleEventRowFixture(suffix, receivedAtMs);
  return {
    ...row,
    type,
    install_id: installId,
    from_bundle_id: row.to_bundle_id,
    update_strategy: "appVersion",
  };
};

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

    it("pages insights events newest first with a stable cursor", async () => {
      const plugin = state.getPlugin();
      const first = createBundleEventRowFixture("701", 100);
      const second = createBundleEventRowFixture("702", 100);
      const third = createBundleEventRowFixture("703", 200);
      await plugin.models.insights.record({
        event: third,
        installation: toInsightsInstallationRow(third),
      });
      await plugin.models.insights.record({
        event: second,
        installation: toInsightsInstallationRow(second),
      });
      await plugin.models.insights.record({
        event: first,
        installation: toInsightsInstallationRow(first),
      });

      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 201,
            limit: 2,
          }),
        [third, second],
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            after: { receivedAtMs: second.received_at_ms, id: second.id },
            beforeReceivedAtMs: 201,
            limit: 2,
          }),
        [first],
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 200,
            limit: 10,
          }),
        [second, first],
      );
    });

    it("filters installation movements before applying the page limit", async () => {
      const plugin = state.getPlugin();
      const adopted = createMovementEvent(
        "711",
        300,
        "RELEASE_ADOPTED",
        "install-target",
      );
      const unrelated = createMovementEvent(
        "712",
        250,
        "UPDATE_APPLIED",
        "install-other",
      );
      const applied = createMovementEvent(
        "713",
        200,
        "UPDATE_APPLIED",
        "install-target",
      );
      const recovered = createMovementEvent(
        "714",
        100,
        "RECOVERED",
        "install-target",
      );
      for (const row of [adopted, unrelated, applied, recovered]) {
        await plugin.models.insights.record({
          event: row,
          installation: toInsightsInstallationRow(row),
        });
      }

      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: {
              kind: "installationMovement",
              installId: "install-target",
            },
            beforeReceivedAtMs: 301,
            limit: 1,
          }),
        [applied],
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: {
              kind: "installationMovement",
              installId: "install-target",
            },
            after: {
              receivedAtMs: applied.received_at_ms,
              id: applied.id,
            },
            beforeReceivedAtMs: 301,
            limit: 1,
          }),
        [recovered],
      );
    });

    it("keeps the newest installation state and indexes its current user", async () => {
      const plugin = state.getPlugin();
      const previous = {
        ...createBundleEventRowFixture("721", 100),
        install_id: "install-a",
        user_id: "user-previous",
        username: "Previous",
      };
      const current = {
        ...createBundleEventRowFixture("722", 200),
        install_id: "install-a",
        user_id: "user-current",
        username: "Current",
      };
      const secondInstallation = {
        ...createBundleEventRowFixture("723", 150),
        install_id: "install-b",
        user_id: "user-current",
        username: "Current",
      };
      await plugin.models.insights.record({
        event: previous,
        installation: toInsightsInstallationRow(previous),
      });
      await plugin.models.insights.record({
        event: current,
        installation: toInsightsInstallationRow(current),
      });
      await plugin.models.insights.record({
        event: secondInstallation,
        installation: toInsightsInstallationRow(secondInstallation),
      });

      await expect(
        plugin.models.insights.findInstallations({ installId: "install-a" }),
      ).resolves.toEqual([toInsightsInstallationRow(current)]);
      await expect(
        plugin.models.insights.findInstallations({
          userId: "user-previous",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.findInstallations({
            userId: "user-current",
            limit: 1,
          }),
        [toInsightsInstallationRow(current)],
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.findInstallations({
            userId: "user-current",
            afterInstallId: "install-a",
            limit: 10,
          }),
        [toInsightsInstallationRow(secondInstallation)],
      );
    });

    it("does not let late events regress the current installation state", async () => {
      const plugin = state.getPlugin();
      const current = {
        ...createBundleEventRowFixture("732", 200),
        install_id: "install-late",
      };
      const olderTimestamp = {
        ...createBundleEventRowFixture("733", 100),
        install_id: "install-late",
      };
      const smallerIdAtSameTimestamp = {
        ...createBundleEventRowFixture("731", 200),
        install_id: "install-late",
      };
      await plugin.models.insights.record({
        event: current,
        installation: toInsightsInstallationRow(current),
      });
      await plugin.models.insights.record({
        event: olderTimestamp,
        installation: toInsightsInstallationRow(olderTimestamp),
      });
      await plugin.models.insights.record({
        event: smallerIdAtSameTimestamp,
        installation: toInsightsInstallationRow(smallerIdAtSameTimestamp),
      });

      await expect(
        plugin.models.insights.findInstallations({ installId: "install-late" }),
      ).resolves.toEqual([toInsightsInstallationRow(current)]);
    });

    it("counts current active installations instead of raw event rows", async () => {
      const plugin = state.getPlugin();
      const repeated = [
        {
          ...createBundleEventRowFixture("741", 100),
          install_id: "install-active-a",
        },
        {
          ...createBundleEventRowFixture("742", 200),
          install_id: "install-active-a",
        },
        {
          ...createBundleEventRowFixture("743", 300),
          install_id: "install-active-a",
        },
      ];
      const inactive = {
        ...createBundleEventRowFixture("744", 99),
        install_id: "install-inactive",
      };
      const active = {
        ...createBundleEventRowFixture("745", 100),
        install_id: "install-active-b",
      };
      for (const row of [...repeated, inactive, active]) {
        await plugin.models.insights.record({
          event: row,
          installation: toInsightsInstallationRow(row),
        });
      }

      await expectInsightsIndex(
        () =>
          plugin.models.insights.countInstallations({
            platform: "ios",
            channel: "production",
            sinceMs: 100,
          }),
        2,
      );
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

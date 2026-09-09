import {
  type BundleEventRow,
  type DatabasePlugin,
  type InsightsBundleEventFilter,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleEventRowFixture } from "./databaseTestFixtures";
import { expectInsightsIndex } from "./expectInsightsIndex";

const record = (plugin: DatabasePlugin, event: BundleEventRow) =>
  plugin.models.insights.record({
    event,
  });

export const registerDatabasePluginInsightsTests = (
  state: DatabasePluginTestState<DatabasePlugin>,
): void => {
  describe("Insights report contract", () => {
    it("preserves ancillary JSON through event history and latest-event reads", async () => {
      const plugin = state.getPlugin();
      const base = createBundleEventRowFixture("979", 100);
      const event = {
        ...base,
        metadata: {
          ...base.metadata,
          device: { locale: "ko-KR", tags: ["minor", null, true, 2] },
          diagnostic: null,
        },
      };
      await record(plugin, event);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([event]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 101,
            limit: 10,
          }),
        [event],
      );
    });

    it("selects the latest complete event across download, replacement, apply, and delayed reports", async () => {
      const plugin = state.getPlugin();
      const download: BundleEventRow = {
        ...createBundleEventRowFixture("980", 100),
        type: "UPDATE_DOWNLOADED",
        from_bundle_id: "00000000-0000-7000-8000-000000001980",
        metadata: {
          ...createBundleEventRowFixture("980", 100).metadata,
          update_strategy: "appVersion",
        },
        to_release_id: "00000000-0000-7000-8000-000000004980",
      };
      await record(plugin, download);
      await record(plugin, download);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([download]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: {
              kind: "bundle",
              type: "UPDATE_DOWNLOADED",
              toBundleId: download.to_bundle_id,
              platform: "ios",
              channel: "production",
            },
            beforeReceivedAtMs: 200,
            limit: 10,
          }),
        [download],
      );
      const replacement: BundleEventRow = {
        ...download,
        id: createBundleEventRowFixture("981", 110).id,
        received_at_ms: 110,
        to_bundle_id: "00000000-0000-7000-8000-000000002981",
      };
      await record(plugin, replacement);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([replacement]);
      const applied: BundleEventRow = {
        ...replacement,
        type: "UPDATE_APPLIED",
        id: createBundleEventRowFixture("982", 120).id,
        received_at_ms: 120,
      };
      await record(plugin, applied);
      await record(plugin, {
        ...download,
        id: createBundleEventRowFixture("983", 105).id,
        received_at_ms: 105,
      });
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([applied]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: {
              kind: "installationMovement",
              installId: download.install_id,
            },
            beforeReceivedAtMs: 200,
            limit: 10,
          }),
        [
          applied,
          replacement,
          {
            ...download,
            id: createBundleEventRowFixture("983", 105).id,
            received_at_ms: 105,
          },
          download,
        ],
      );
    });

    it("treats duplicate IDs as complete no-ops, including changed retry payloads", async () => {
      const plugin = state.getPlugin();
      const event = createBundleEventRowFixture("901", 100);
      await Promise.all([
        record(plugin, event),
        record(plugin, event),
        record(plugin, event),
      ]);
      await record(plugin, event);
      const changed = {
        ...event,
        received_at_ms: 300,
        user_id: "changed-user",
      };
      await record(plugin, changed);
      const otherInstallation = { ...changed, install_id: "different-install" };
      await record(plugin, otherInstallation);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([event]);
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: otherInstallation.install_id,
        }),
      ).resolves.toEqual([]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 400,
            limit: 10,
          }),
        [event],
      );
    });

    it("keeps all concurrent events and the greatest timestamp/ID state, including logout", async () => {
      const plugin = state.getPlugin();
      const older = {
        ...createBundleEventRowFixture("912", 100),
        install_id: "concurrent",
        user_id: "previous",
      };
      const tied = {
        ...createBundleEventRowFixture("910", 200),
        install_id: "concurrent",
        user_id: "previous",
      };
      const newest = {
        ...createBundleEventRowFixture("911", 200),
        install_id: "concurrent",
        user_id: null,
      };
      await Promise.all([
        record(plugin, newest),
        record(plugin, older),
        record(plugin, tied),
      ]);
      await record(plugin, older);
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "concurrent" }),
      ).resolves.toEqual([newest]);
      await expect(
        plugin.models.insights.findLatestEvents({
          userId: "previous",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 201,
            limit: 10,
          }),
        [newest, tied, older],
      );
    });

    it("rejects invalid event metadata before persisting a report", async () => {
      const plugin = state.getPlugin();
      const event = createBundleEventRowFixture("920", 100);
      await expect(
        plugin.models.insights.record({
          event: {
            ...event,
            metadata: { ...event.metadata, cohort: 123 },
          } as unknown as BundleEventRow,
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      await expect(
        plugin.models.insights.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.listEvents({
          filter: { kind: "all" },
          beforeReceivedAtMs: 200,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it("shares scoped list/count predicates, recovery attribution, and half-open time bounds", async () => {
      const plugin = state.getPlugin();
      const bundleA = createBundleEventRowFixture("1", 0).to_bundle_id;
      const bundleB = createBundleEventRowFixture("2", 0).to_bundle_id;
      const bundleC = createBundleEventRowFixture("3", 0).to_bundle_id;
      const applied = {
        ...createBundleEventRowFixture("930", 100),
        install_id: "target",
        to_bundle_id: bundleB,
      };
      const recovered: BundleEventRow = {
        ...createBundleEventRowFixture("931", 120),
        install_id: "target",
        type: "RECOVERED",
        from_bundle_id: bundleB,
        to_bundle_id: bundleA,
        metadata: {
          ...createBundleEventRowFixture("931", 120).metadata,
          update_strategy: "appVersion",
        },
      };
      const unchanged: BundleEventRow = {
        ...createBundleEventRowFixture("932", 130),
        type: "UNCHANGED",
        from_bundle_id: null,
        to_bundle_id: bundleB,
        metadata: {
          ...createBundleEventRowFixture("932", 130).metadata,
          update_strategy: null,
        },
      };
      const excluded = [
        {
          ...applied,
          id: createBundleEventRowFixture("933", 99).id,
          install_id: "before",
          received_at_ms: 99,
        },
        {
          ...applied,
          id: createBundleEventRowFixture("934", 200).id,
          install_id: "after",
          received_at_ms: 200,
        },
        {
          ...applied,
          id: createBundleEventRowFixture("935", 110).id,
          install_id: "android",
          platform: "android" as const,
        },
        {
          ...applied,
          id: createBundleEventRowFixture("936", 110).id,
          install_id: "preview",
          channel: "preview",
        },
        {
          ...recovered,
          id: createBundleEventRowFixture("937", 125).id,
          install_id: "other-source",
          from_bundle_id: bundleC,
          to_bundle_id: bundleB,
        },
      ];
      for (const row of [applied, recovered, unchanged, ...excluded])
        await record(plugin, row);
      await expect(async () =>
        record(plugin, {
          ...applied,
          type: "RELEASE_ADOPTED",
        } as unknown as BundleEventRow),
      ).rejects.toThrow();
      await expect(async () =>
        record(plugin, {
          ...applied,
          type: "UNCHANGED",
          from_bundle_id: bundleB,
          metadata: { ...applied.metadata, update_strategy: "appVersion" },
        } as unknown as BundleEventRow),
      ).rejects.toThrow();
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "target" }),
      ).resolves.toEqual([recovered]);
      const cases: readonly [InsightsBundleEventFilter, BundleEventRow][] = [
        [
          {
            platform: "ios",
            channel: "production",
            type: "UPDATE_APPLIED",
            toBundleId: bundleB,
          },
          applied,
        ],
        [
          {
            platform: "ios",
            channel: "production",
            type: "RECOVERED",
            fromBundleId: bundleB,
          },
          recovered,
        ],
        [
          {
            platform: "ios",
            channel: "production",
            type: "UNCHANGED",
            toBundleId: bundleB,
          },
          unchanged,
        ],
      ];
      for (const [filter, expected] of cases) {
        await expectInsightsIndex(
          () =>
            plugin.models.insights.countEvents({
              filter,
              sinceMs: 100,
              beforeReceivedAtMs: 200,
            }),
          1,
        );
        await expectInsightsIndex(
          () =>
            plugin.models.insights.listEvents({
              filter: { kind: "bundle", ...filter },
              sinceMs: 100,
              beforeReceivedAtMs: 200,
              limit: 1,
            }),
          [expected],
        );
      }
      await expectInsightsIndex(
        () =>
          plugin.models.insights.countLatestEvents({
            platform: "ios",
            channel: "production",
            sinceMs: 100,
            bundle: [
              {
                field: "to_bundle_id",
                value: bundleA,
                types: ["UNCHANGED", "UPDATE_APPLIED", "RECOVERED"],
              },
            ],
          }),
        1,
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.countLatestEvents({
            platform: "ios",
            channel: "production",
            sinceMs: 100,
          }),
        4,
      );
    });

    it("uses exact identity and UTF-8 cursor order for user installations", async () => {
      const plugin = state.getPlugin();
      const ids = [
        "Install-a",
        "e\u0301",
        "install-a",
        "install-a ",
        "é",
        "\ue000",
        "😀",
      ];
      const events = ids.map((install_id, index) => ({
        ...createBundleEventRowFixture(String(950 + index), 100),
        install_id,
        user_id: "User-é",
      }));
      for (const event of events.toReversed()) await record(plugin, event);
      const spacedUser = {
        ...createBundleEventRowFixture("960", 100),
        install_id: "spaced-user-install",
        user_id: "User-é ",
      };
      await record(plugin, spacedUser);
      await expectInsightsIndex(async () => {
        const found: string[] = [];
        let afterInstallId: string | undefined;
        for (;;) {
          const page = await plugin.models.insights.findLatestEvents({
            userId: "User-é",
            afterInstallId,
            limit: 2,
          });
          found.push(...page.map((row) => row.install_id));
          if (page.length < 2) return found;
          afterInstallId = page[page.length - 1]!.install_id;
        }
      }, ids);
      await expectInsightsIndex(
        () =>
          plugin.models.insights.findLatestEvents({
            userId: "User-é ",
            limit: 10,
          }),
        [spacedUser],
      );
      await expect(
        plugin.models.insights.findLatestEvents({
          userId: "user-é",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "INSTALL-a" }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "Install-a" }),
      ).resolves.toEqual([events[0]!]);
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "install-a " }),
      ).resolves.toEqual([events[3]!]);
      await expect(
        plugin.models.insights.findLatestEvents({ installId: "install-a" }),
      ).resolves.toEqual([events[2]!]);
    });

    it("counts overlapping bundle predicates once per latest installation", async () => {
      const plugin = state.getPlugin();
      const event = createBundleEventRowFixture("9700", 100);
      await record(plugin, event);
      const predicate = {
        field: "to_bundle_id" as const,
        value: event.to_bundle_id,
        types: [event.type],
      };
      await expectInsightsIndex(
        () =>
          plugin.models.insights.countLatestEvents({
            platform: event.platform,
            channel: event.channel,
            sinceMs: 0,
            bundle: [predicate, predicate],
          }),
        1,
      );
    });

    it("returns zero for successful empty scalar queries", async () => {
      const plugin = state.getPlugin();
      await expect(
        plugin.models.insights.countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 0,
        }),
      ).resolves.toBe(0);
      await expect(
        plugin.models.insights.countEvents({
          filter: {
            platform: "ios",
            channel: "production",
            type: "RECOVERED",
            fromBundleId: createBundleEventRowFixture("1", 0).to_bundle_id,
          },
          sinceMs: 0,
          beforeReceivedAtMs: 100,
        }),
      ).resolves.toBe(0);
    });
  });
};

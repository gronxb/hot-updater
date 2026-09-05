import {
  toInsightsInstallationRow,
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
    installation: toInsightsInstallationRow(event),
  });

export const registerDatabasePluginInsightsTests = (
  state: DatabasePluginTestState<DatabasePlugin>,
): void => {
  describe("Insights report contract", () => {
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
        plugin.models.insights.findInstallations({
          installId: event.install_id,
        }),
      ).resolves.toEqual([toInsightsInstallationRow(event)]);
      await expect(
        plugin.models.insights.findInstallations({
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
        username: null,
      };
      await Promise.all([
        record(plugin, newest),
        record(plugin, older),
        record(plugin, tied),
      ]);
      await record(plugin, older);
      await expect(
        plugin.models.insights.findInstallations({ installId: "concurrent" }),
      ).resolves.toEqual([toInsightsInstallationRow(newest)]);
      await expect(
        plugin.models.insights.findInstallations({
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

    it("rejects mismatched prepared state before either canonical record is persisted", async () => {
      const plugin = state.getPlugin();
      const event = createBundleEventRowFixture("920", 100);
      await expect(
        plugin.models.insights.record({
          event,
          installation: {
            ...toInsightsInstallationRow(event),
            user_id: "wrong",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      await expect(
        plugin.models.insights.findInstallations({
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
        update_strategy: "appVersion",
      };
      const adopted: BundleEventRow = {
        ...createBundleEventRowFixture("932", 130),
        type: "RELEASE_ADOPTED",
        from_bundle_id: bundleB,
        to_bundle_id: bundleB,
        update_strategy: "appVersion",
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
      for (const row of [applied, recovered, adopted, ...excluded])
        await record(plugin, row);
      await expect(
        plugin.models.insights.findInstallations({ installId: "target" }),
      ).resolves.toEqual([toInsightsInstallationRow(recovered)]);
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
            type: "RELEASE_ADOPTED",
            toBundleId: bundleB,
          },
          adopted,
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
          plugin.models.insights.countInstallations({
            platform: "ios",
            channel: "production",
            sinceMs: 100,
            bundleId: bundleA,
          }),
        1,
      );
      await expectInsightsIndex(
        () =>
          plugin.models.insights.countInstallations({
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
          const page = await plugin.models.insights.findInstallations({
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
          plugin.models.insights.findInstallations({
            userId: "User-é ",
            limit: 10,
          }),
        [toInsightsInstallationRow(spacedUser)],
      );
      await expect(
        plugin.models.insights.findInstallations({
          userId: "user-é",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.findInstallations({ installId: "INSTALL-a" }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.findInstallations({ installId: "Install-a" }),
      ).resolves.toEqual([toInsightsInstallationRow(events[0]!)]);
      await expect(
        plugin.models.insights.findInstallations({ installId: "install-a " }),
      ).resolves.toEqual([toInsightsInstallationRow(events[3]!)]);
      await expect(
        plugin.models.insights.findInstallations({ installId: "install-a" }),
      ).resolves.toEqual([toInsightsInstallationRow(events[2]!)]);
    });

    it("returns zero for successful empty scalar queries", async () => {
      const plugin = state.getPlugin();
      await expect(
        plugin.models.insights.countInstallations({
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

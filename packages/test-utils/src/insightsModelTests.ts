import {
  type BundleEventRow,
  type InsightsBundleEventFilter,
  type InsightsModel,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "./databaseTestFixtures";
import type { DatabaseTestState } from "./databaseTestRunner";
import { expectInsightsIndex } from "./expectInsightsIndex";

const record = (model: InsightsModel, event: BundleEventRow) =>
  model.recordEvent({ event });

const createMovementEvent = (
  suffix: string,
  receivedAtMs: number,
  type: "UPDATE_APPLIED" | "RECOVERED",
  installId: string,
): BundleEventRow => {
  const row = createBundleEventRowFixture(suffix, receivedAtMs);
  return {
    ...row,
    type,
    install_id: installId,
    from_bundle_id: row.to_bundle_id,
    metadata: { ...row.metadata, update_strategy: "appVersion" },
  };
};

/**
 * The Insights report contract on `InsightsModel`: what the Insights plugin
 * records and reads, through `createInsightsModel`, on one database.
 */
export const registerInsightsModelTests = (
  state: DatabaseTestState<InsightsModel>,
): void => {
  describe("Insights report contract", () => {
    it("preserves ancillary JSON through event history and latest-event reads", async () => {
      const model = state.getDatabase();
      const base = createBundleEventRowFixture("979", 100);
      const event = {
        ...base,
        metadata: {
          ...base.metadata,
          device: { locale: "ko-KR", tags: ["minor", null, true, 2] },
          diagnostic: null,
        },
      };
      await record(model, event);
      await expect(
        model.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([event]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 101,
            limit: 10,
          }),
        [event],
      );
    });

    it("selects the latest complete event across download, replacement, apply, and delayed reports", async () => {
      const model = state.getDatabase();
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
      await record(model, download);
      await record(model, download);
      await expect(
        model.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([download]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
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
      await record(model, replacement);
      await expect(
        model.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([replacement]);
      const applied: BundleEventRow = {
        ...replacement,
        type: "UPDATE_APPLIED",
        id: createBundleEventRowFixture("982", 120).id,
        received_at_ms: 120,
      };
      await record(model, applied);
      await record(model, {
        ...download,
        id: createBundleEventRowFixture("983", 105).id,
        received_at_ms: 105,
      });
      await expect(
        model.findLatestEvents({
          installId: download.install_id,
        }),
      ).resolves.toEqual([applied]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
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
      const model = state.getDatabase();
      const event = createBundleEventRowFixture("901", 100);
      await Promise.all([
        record(model, event),
        record(model, event),
        record(model, event),
      ]);
      await record(model, event);
      const changed = {
        ...event,
        received_at_ms: 300,
        user_id: "changed-user",
      };
      await record(model, changed);
      const otherInstallation = { ...changed, install_id: "different-install" };
      await record(model, otherInstallation);
      await expect(
        model.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([event]);
      await expect(
        model.findLatestEvents({
          installId: otherInstallation.install_id,
        }),
      ).resolves.toEqual([]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 400,
            limit: 10,
          }),
        [event],
      );
    });

    it("keeps all concurrent events and the greatest timestamp/ID state, including logout", async () => {
      const model = state.getDatabase();
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
        record(model, newest),
        record(model, older),
        record(model, tied),
      ]);
      await record(model, older);
      await expect(
        model.findLatestEvents({ installId: "concurrent" }),
      ).resolves.toEqual([newest]);
      await expect(
        model.findLatestEvents({
          userId: "previous",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 201,
            limit: 10,
          }),
        [newest, tied, older],
      );
    });

    it("rejects invalid event metadata before persisting a report", async () => {
      const model = state.getDatabase();
      const event = createBundleEventRowFixture("920", 100);
      await expect(
        model.recordEvent({
          event: {
            ...event,
            metadata: { ...event.metadata, cohort: 123 },
          } as unknown as BundleEventRow,
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      await expect(
        model.findLatestEvents({
          installId: event.install_id,
        }),
      ).resolves.toEqual([]);
      await expect(
        model.listEvents({
          filter: { kind: "all" },
          beforeReceivedAtMs: 200,
          limit: 10,
        }),
      ).resolves.toEqual([]);
    });

    it("shares scoped list/count predicates, recovery attribution, and half-open time bounds", async () => {
      const model = state.getDatabase();
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
        await record(model, row);
      await expect(async () =>
        record(model, {
          ...applied,
          type: "RELEASE_ADOPTED",
        } as unknown as BundleEventRow),
      ).rejects.toThrow();
      await expect(async () =>
        record(model, {
          ...applied,
          type: "UNCHANGED",
          from_bundle_id: bundleB,
          metadata: { ...applied.metadata, update_strategy: "appVersion" },
        } as unknown as BundleEventRow),
      ).rejects.toThrow();
      await expect(
        model.findLatestEvents({ installId: "target" }),
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
            model.countEvents({
              filter,
              sinceMs: 100,
              beforeReceivedAtMs: 200,
            }),
          1,
        );
        await expectInsightsIndex(
          () =>
            model.listEvents({
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
          model.countLatestEvents({
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
          model.countLatestEvents({
            platform: "ios",
            channel: "production",
            sinceMs: 100,
          }),
        4,
      );
    });

    it("uses exact identity and UTF-8 cursor order for user installations", async () => {
      const model = state.getDatabase();
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
      for (const event of events.toReversed()) await record(model, event);
      const spacedUser = {
        ...createBundleEventRowFixture("960", 100),
        install_id: "spaced-user-install",
        user_id: "User-é ",
      };
      await record(model, spacedUser);
      await expectInsightsIndex(async () => {
        const found: string[] = [];
        let afterInstallId: string | undefined;
        for (let pageIndex = 0; pageIndex <= ids.length; pageIndex++) {
          const page = await model.findLatestEvents({
            userId: "User-é",
            afterInstallId,
            limit: 2,
          });
          found.push(...page.map((row) => row.install_id));
          if (page.length < 2) return found;
          const nextCursor = page[page.length - 1]!.install_id;
          expect(nextCursor, "Insights cursor must advance").not.toBe(
            afterInstallId,
          );
          afterInstallId = nextCursor;
        }
        throw new Error("Insights pagination did not terminate");
      }, ids);
      await expectInsightsIndex(
        () =>
          model.findLatestEvents({
            userId: "User-é ",
            limit: 10,
          }),
        [spacedUser],
      );
      await expect(
        model.findLatestEvents({
          userId: "user-é",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        model.findLatestEvents({ installId: "INSTALL-a" }),
      ).resolves.toEqual([]);
      await expect(
        model.findLatestEvents({ installId: "Install-a" }),
      ).resolves.toEqual([events[0]!]);
      await expect(
        model.findLatestEvents({ installId: "install-a " }),
      ).resolves.toEqual([events[3]!]);
      await expect(
        model.findLatestEvents({ installId: "install-a" }),
      ).resolves.toEqual([events[2]!]);
    });

    it("counts overlapping bundle predicates once per latest installation", async () => {
      const model = state.getDatabase();
      const event = createBundleEventRowFixture("9700", 100);
      await record(model, event);
      const predicate = {
        field: "to_bundle_id" as const,
        value: event.to_bundle_id,
        types: [event.type],
      };
      await expectInsightsIndex(
        () =>
          model.countLatestEvents({
            platform: event.platform,
            channel: event.channel,
            sinceMs: 0,
            bundle: [predicate, predicate],
          }),
        1,
      );
    });

    it("returns zero for successful empty scalar queries", async () => {
      const model = state.getDatabase();
      await expect(
        model.countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 0,
        }),
      ).resolves.toBe(0);
      await expect(
        model.countEvents({
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

    it("maintains idempotent release, scope, usage, and latest-distribution summaries", async () => {
      const model = state.getDatabase();
      const releaseA = "00000000-0000-7000-8000-000000008001";
      const releaseB = "00000000-0000-7000-8000-000000008002";
      const base = createBundleEventRowFixture("9801", 1_000);
      const download: BundleEventRow = {
        ...base,
        type: "UPDATE_DOWNLOADED",
        install_id: "summary-install-a",
        from_release_id: releaseA,
        to_release_id: releaseB,
      };
      const appliedA: BundleEventRow = {
        ...download,
        id: createBundleEventRowFixture("9802", 2_000).id,
        type: "UPDATE_APPLIED",
        received_at_ms: 2_000,
      };
      const appliedB: BundleEventRow = {
        ...appliedA,
        id: createBundleEventRowFixture("9803", 2_100).id,
        install_id: "summary-install-b",
        received_at_ms: 2_100,
      };
      const recovered: BundleEventRow = {
        ...appliedA,
        id: createBundleEventRowFixture("9804", 3_000).id,
        type: "RECOVERED",
        from_release_id: releaseB,
        to_release_id: releaseA,
        received_at_ms: 3_000,
      };
      for (const event of [download, appliedA, appliedB, appliedB, recovered]) {
        await record(model, event);
      }
      const releases = [
        { releaseId: releaseA, platform: "ios", channel: "production" },
        { releaseId: releaseB, platform: "ios", channel: "production" },
      ] as const;
      const lifetime = await model.getReleaseActivity({
        releases,
      });
      expect(lifetime.data.map(({ metrics }) => metrics)).toEqual([
        { downloads: 0, launches: 1, failedLaunches: 0 },
        { downloads: 1, launches: 2, failedLaunches: 1 },
      ]);
      const scope = await model.getReleaseActivity({
        scope: { platform: "ios", channel: "production" },
        timeRange: { start: 0, end: 3_600_000 },
      });
      expect(scope.data[0]?.metrics).toMatchObject({
        downloads: 1,
        launches: 3,
        failedLaunches: 1,
        uniqueUsers: 2,
      });
      const usage = await model.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      });
      expect(usage.activeInstallations).toBe(2);
      expect(usage.points).toEqual([{ startMs: 0, installations: 2 }]);
      expect(usage.bundleDistribution).toEqual(
        expect.arrayContaining([
          {
            appVersion: "1.0.0",
            platform: "ios",
            releaseId: releaseA,
            installations: 1,
          },
          {
            appVersion: "1.0.0",
            platform: "ios",
            releaseId: releaseB,
            installations: 1,
          },
        ]),
      );
    });
    it("pages insights events newest first with a stable cursor", async () => {
      const model = state.getDatabase();
      const first = createBundleEventRowFixture("701", 100);
      const second = createBundleEventRowFixture("702", 100);
      const third = createBundleEventRowFixture("703", 200);
      await model.recordEvent({
        event: third,
      });
      await model.recordEvent({
        event: second,
      });
      await model.recordEvent({
        event: first,
      });

      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 201,
            limit: 2,
          }),
        [third, second],
      );
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            after: { receivedAtMs: second.received_at_ms, id: second.id },
            beforeReceivedAtMs: 201,
            limit: 2,
          }),
        [first],
      );
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 200,
            limit: 10,
          }),
        [second, first],
      );
    });

    it("filters installation movements before applying the page limit", async () => {
      const model = state.getDatabase();
      const unchanged: BundleEventRow = {
        ...createBundleEventRowFixture("711", 300),
        type: "UNCHANGED",
        install_id: "install-target",
        from_bundle_id: null,
        metadata: {
          ...createBundleEventRowFixture("711", 300).metadata,
          update_strategy: null,
        },
      };
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
      for (const row of [unchanged, unrelated, applied, recovered]) {
        await model.recordEvent({
          event: row,
        });
      }

      await expectInsightsIndex(
        () =>
          model.listEvents({
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
          model.listEvents({
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
  });
};

import type {
  BundleEventRow,
  InsightsBundleEventFilter,
  InsightsModel,
} from "@hot-updater/plugin-insights/server";
import { describe, expect, it } from "vitest";

import type { DatabaseTestState } from "../databaseTestRunner";
import { expectInsightsIndex } from "./expectInsightsIndex";
import { createBundleEventRowFixture } from "./fixtures";

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
      // An installation's first UNCHANGED report is kept as first seen: in
      // the lists, but under no bundle, since it launched nothing new.
      const firstSeen = {
        ...unchanged,
        metadata: {
          ...unchanged.metadata,
          change: { kinds: ["first_seen"], previous: null },
        },
      } as BundleEventRow;
      await expect(
        model.findLatestEvents({ installId: unchanged.install_id }),
      ).resolves.toEqual([firstSeen]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            sinceMs: 100,
            beforeReceivedAtMs: 200,
            limit: 10,
          }),
        // Newest first, ids breaking ties.
        [firstSeen, excluded[4], recovered, excluded[3], excluded[2], applied],
      );
      await expectInsightsIndex(
        () =>
          model.countEvents({
            filter: {
              platform: "ios",
              channel: "production",
              type: "UNCHANGED",
              toBundleId: bundleB,
            },
            sinceMs: 100,
            beforeReceivedAtMs: 200,
          }),
        0,
      );
      // Latest events count whole UTC days: every head above lies in day 0.
      await expectInsightsIndex(
        () =>
          model.countLatestEvents({
            platform: "ios",
            channel: "production",
            sinceMs: 0,
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
            sinceMs: 0,
          }),
        5,
      );
      await expect(
        model.countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 100,
        }),
      ).rejects.toThrow();
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

    it("counts a latest installation once when a from and a to predicate both match it", async () => {
      const model = state.getDatabase();
      const moved = createBundleEventRowFixture("9701", 100);
      await record(model, moved);
      await expectInsightsIndex(
        () =>
          model.countLatestEvents({
            platform: moved.platform,
            channel: moved.channel,
            sinceMs: 0,
            bundle: [
              {
                field: "from_bundle_id",
                value: moved.from_bundle_id,
                types: [moved.type],
              },
              {
                field: "to_bundle_id",
                value: moved.to_bundle_id,
                types: [moved.type],
              },
            ],
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

    it("maintains idempotent release, event series, usage, and latest-distribution summaries", async () => {
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
      // The launch of B crashed, and the installation went back to A.
      const recovered: BundleEventRow = {
        ...appliedA,
        id: createBundleEventRowFixture("9804", 3_000).id,
        type: "RECOVERED",
        from_release_id: releaseB,
        from_bundle_id: base.to_bundle_id,
        to_release_id: releaseA,
        to_bundle_id: base.from_bundle_id,
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
      // Two installations applied B, and its repeated report counts once;
      // the recovery back to A crashed on B and applies nothing.
      expect(lifetime.data.map(({ metrics }) => metrics)).toEqual([
        { downloads: 0, applies: 0, failedLaunches: 0 },
        { downloads: 1, applies: 2, failedLaunches: 1 },
      ]);
      // A bundle filter's stored events in each hour, every hour present:
      // the repeated apply counts once.
      const hourly = (filter: InsightsBundleEventFilter) =>
        model.countEventSeries({
          filter,
          timeRange: { start: 0, end: 3 * 3_600_000 },
          intervalMs: 3_600_000,
        });
      const points = (...counts: number[]) =>
        counts.map((events, index) => ({
          startMs: index * 3_600_000,
          events,
        }));
      const scope = { platform: "ios", channel: "production" } as const;
      await expectInsightsIndex(
        () =>
          hourly({
            ...scope,
            type: "UPDATE_APPLIED",
            toBundleId: base.to_bundle_id,
          }),
        points(2, 0, 0),
      );
      await expectInsightsIndex(
        () =>
          hourly({
            ...scope,
            type: "RECOVERED",
            fromBundleId: base.to_bundle_id,
          }),
        points(1, 0, 0),
      );
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
            builtinBundleId: null,
            installations: 1,
          },
          {
            appVersion: "1.0.0",
            platform: "ios",
            releaseId: releaseB,
            builtinBundleId: null,
            installations: 1,
          },
        ]),
      );
    });
    it("distributes installations on their native build's built-in bundle by its ID", async () => {
      const model = state.getDatabase();
      const channel = "builtin-distribution";
      const launch = (
        suffix: string,
        bundleId: string,
        minBundleId: string,
      ): BundleEventRow => {
        const base = createBundleEventRowFixture(suffix, 1_000);
        return {
          ...base,
          type: "UNCHANGED",
          channel,
          from_bundle_id: null,
          to_bundle_id: bundleId,
          metadata: {
            ...base.metadata,
            update_strategy: null,
            min_bundle_id: minBundleId,
          },
        };
      };
      const builtin = createBundleEventRowFixture("9901", 0).id;
      await record(model, launch("9902", builtin, builtin));
      await record(model, launch("9903", builtin, builtin));
      // A bundle without a release that is not the build's own is unknown.
      await record(
        model,
        launch("9904", createBundleEventRowFixture("9905", 0).id, builtin),
      );
      const usage = await model.getAppUsage({
        channel,
        platform: "ios",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      });
      expect(usage.bundleDistribution).toEqual(
        expect.arrayContaining([
          {
            appVersion: "1.0.0",
            platform: "ios",
            releaseId: null,
            builtinBundleId: builtin,
            installations: 2,
          },
          {
            appVersion: "1.0.0",
            platform: "ios",
            releaseId: null,
            builtinBundleId: null,
            installations: 1,
          },
        ]),
      );
      expect(usage.bundleDistribution).toHaveLength(2);
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
      // A launch on the bundle the apply moved to changes nothing, so no row
      // keeps it.
      const unchanged: BundleEventRow = {
        ...applied,
        id: createBundleEventRowFixture("711", 300).id,
        type: "UNCHANGED",
        from_bundle_id: null,
        from_release_id: null,
        metadata: { ...applied.metadata, update_strategy: null },
        received_at_ms: 300,
      };
      for (const row of [recovered, unrelated, applied, unchanged]) {
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

    it("keeps an UNCHANGED report only when it changes what its installation runs, and counts the release it launched", async () => {
      const model = state.getDatabase();
      const day = 86_400_000;
      const releaseA = "00000000-0000-7000-8000-000000009a01";
      const releaseB = "00000000-0000-7000-8000-000000009a02";
      const base = createBundleEventRowFixture("9910", 1_000);
      const launch = (
        suffix: string,
        receivedAtMs: number,
        fields: Partial<BundleEventRow> = {},
      ) =>
        ({
          ...base,
          id: createBundleEventRowFixture(suffix, receivedAtMs).id,
          type: "UNCHANGED",
          install_id: "install-kept",
          from_bundle_id: null,
          from_release_id: null,
          to_bundle_id: base.from_bundle_id,
          to_release_id: releaseA,
          metadata: { ...base.metadata, update_strategy: null },
          received_at_ms: receivedAtMs,
          ...fields,
        }) as BundleEventRow;
      const first = launch("9911", 1_000);
      // The next day, on the same bundle: a launch that changes nothing.
      const same = launch("9912", day + 1_000);
      // A release the installation runs with no apply report for it.
      const moved = launch("9913", day + 2_000, {
        to_bundle_id: base.to_bundle_id,
        to_release_id: releaseB,
      });
      for (const row of [first, same, moved]) await record(model, row);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "installationMovement", installId: "install-kept" },
            beforeReceivedAtMs: 2 * day,
            limit: 10,
          }),
        [
          {
            ...moved,
            metadata: {
              ...moved.metadata,
              // No download report of B came before it: its download counts
              // with the launch.
              implied_download: true,
              change: {
                kinds: ["bundle", "release"],
                previous: {
                  bundle_id: base.from_bundle_id,
                  release_id: releaseA,
                  app_version: base.app_version,
                  channel: base.channel,
                },
              },
            },
          },
          {
            ...first,
            metadata: {
              ...first.metadata,
              change: { kinds: ["first_seen"], previous: null },
            },
          },
        ],
      );
      await expectInsightsIndex(
        () =>
          model.countEvents({
            filter: {
              platform: "ios",
              channel: "production",
              type: "UNCHANGED",
              toBundleId: base.to_bundle_id,
            },
            sinceMs: 0,
            beforeReceivedAtMs: 2 * day,
          }),
        1,
      );
      const activity = await model.getReleaseActivity({
        releases: [
          { releaseId: releaseA, platform: "ios", channel: "production" },
          { releaseId: releaseB, platform: "ios", channel: "production" },
        ],
      });
      // A first report launched nothing; the move launched releaseB and
      // counted the download it implied.
      expect(activity.data.map(({ metrics }) => metrics)).toEqual([
        { downloads: 0, applies: 0, failedLaunches: 0 },
        { downloads: 1, applies: 1, failedLaunches: 0 },
      ]);
    });

    it("counts each launch and download once, so a bundle's launches match its release and its downloads cover launches and crashes", async () => {
      const model = state.getDatabase();
      const day = 86_400_000;
      const releaseA = "00000000-0000-7000-8000-000000009b01";
      const releaseB = "00000000-0000-7000-8000-000000009b02";
      const base = createBundleEventRowFixture("9920", 1_000);
      const bundleA = base.from_bundle_id;
      const bundleB = base.to_bundle_id;
      let sequence = 9920;
      const report = (
        install: string,
        receivedAtMs: number,
        fields: Partial<BundleEventRow>,
      ) => {
        sequence += 1;
        return {
          ...base,
          id: createBundleEventRowFixture(String(sequence), receivedAtMs).id,
          install_id: install,
          from_release_id: releaseA,
          to_release_id: releaseB,
          received_at_ms: receivedAtMs,
          ...fields,
        } as BundleEventRow;
      };
      const launch = (install: string, at: number, bundle: string) =>
        report(install, at, {
          type: "UNCHANGED",
          from_bundle_id: null,
          from_release_id: null,
          to_bundle_id: bundle,
          to_release_id: bundle === bundleA ? releaseA : releaseB,
          metadata: { ...base.metadata, update_strategy: null },
        });
      const download = (install: string, at: number) =>
        report(install, at, { type: "UPDATE_DOWNLOADED" });
      const apply = (install: string, at: number) =>
        report(install, at, { type: "UPDATE_APPLIED" });
      const rows = [
        // A download and its apply.
        launch("i1", 1_000, bundleA),
        download("i1", 2_000),
        apply("i1", 3_000),
        // Neither report came: the next launch on B says it ran B.
        launch("i2", 1_000, bundleA),
        launch("i2", day + 1_000, bundleB),
        // The apply report never came.
        launch("i3", 1_000, bundleA),
        download("i3", 2_000),
        launch("i3", day + 2_000, bundleB),
        // A forced update's download report arrives after its apply.
        launch("i4", 1_000, bundleA),
        apply("i4", 3_000),
        download("i4", 4_000),
        // A download whose launch crashed back to A.
        launch("i5", 1_000, bundleA),
        download("i5", 2_000),
        report("i5", 3_000, {
          type: "RECOVERED",
          from_release_id: releaseB,
          from_bundle_id: bundleB,
          to_release_id: releaseA,
          to_bundle_id: bundleA,
        }),
        // A download reported twice before its launch counts once.
        launch("i6", 1_000, bundleA),
        download("i6", 2_000),
        download("i6", 2_500),
        apply("i6", 3_000),
      ];
      for (const row of rows) await record(model, row);
      const scope = { platform: "ios", channel: "production" } as const;
      const range = { sinceMs: 0, beforeReceivedAtMs: 2 * day };
      const count = (filter: InsightsBundleEventFilter) =>
        model.countEvents({ filter, ...range });
      const [{ metrics }] = (
        await model.getReleaseActivity({
          releases: [{ releaseId: releaseB, ...scope }],
        })
      ).data;
      expect(metrics).toEqual({ downloads: 6, applies: 5, failedLaunches: 1 });
      // The launches a bundle's chart adds equal its release's.
      await expectInsightsIndex(
        async () =>
          (await count({
            ...scope,
            type: "UPDATE_APPLIED",
            toBundleId: bundleB,
          })) +
          (await count({ ...scope, type: "UNCHANGED", toBundleId: bundleB })),
        metrics!.applies,
      );
      // Downloads: the stored download rows and the downloads launches and
      // crashes implied; the late one counts nothing.
      const listed = await model.listEvents({
        filter: { kind: "all" },
        ...range,
        limit: 100,
      });
      const implied = listed.filter(
        ({ metadata }) => metadata.implied_download === true,
      ).length;
      await expectInsightsIndex(
        () =>
          count({ ...scope, type: "UPDATE_DOWNLOADED", toBundleId: bundleB }),
        metrics!.downloads - implied,
      );
      expect(implied).toBe(2);
      expect(metrics!.downloads).toBeGreaterThanOrEqual(
        metrics!.applies + metrics!.failedLaunches,
      );
    });

    it("lists an update failure where its target's list and installation history read it, and a failed check in no bundle list, moving no latest event", async () => {
      const model = state.getDatabase();
      const applied = createMovementEvent(
        "721",
        100,
        "UPDATE_APPLIED",
        "install-failing",
      );
      const failure = (
        suffix: string,
        receivedAtMs: number,
        failed: Record<string, string | number>,
      ): BundleEventRow => ({
        ...applied,
        id: createBundleEventRowFixture(suffix, 0).id,
        type: "UPDATE_FAILED",
        from_bundle_id: applied.to_bundle_id,
        to_bundle_id:
          failed.stage === "check"
            ? applied.to_bundle_id
            : createBundleEventRowFixture("729", 0).to_bundle_id,
        metadata: {
          ...applied.metadata,
          failure: failed as { stage: "check"; reason: "http" },
        },
        received_at_ms: receivedAtMs,
      });
      const download = failure("722", 200, {
        stage: "download",
        reason: "http",
        http_status: 403,
        origin_code: "AccessDenied",
      });
      const check = failure("723", 300, { stage: "check", reason: "http" });
      for (const event of [applied, download, check]) {
        await record(model, event);
      }

      await expect(
        model.findLatestEvents({ installId: "install-failing" }),
      ).resolves.toEqual([applied]);
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: {
              kind: "installationMovement",
              installId: "install-failing",
            },
            beforeReceivedAtMs: 301,
            limit: 10,
          }),
        [check, download, applied],
      );
      await expectInsightsIndex(
        () =>
          model.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 301,
            limit: 10,
          }),
        [check, download, applied],
      );
      const scope = { platform: "ios", channel: "production" } as const;
      for (const [toBundleId, listed] of [
        [download.to_bundle_id, [download]],
        // A failed check names the running bundle, which it did not target.
        [check.to_bundle_id, []],
      ] as const) {
        const filter = { ...scope, type: "UPDATE_FAILED", toBundleId } as const;
        await expectInsightsIndex(
          () =>
            model.listEvents({
              filter: { kind: "bundle", ...filter },
              beforeReceivedAtMs: 301,
              limit: 10,
            }),
          listed,
        );
        await expect(
          model.countEvents({ filter, sinceMs: 0, beforeReceivedAtMs: 301 }),
        ).resolves.toBe(listed.length);
      }
    });
  });
};

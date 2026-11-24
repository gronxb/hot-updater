import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import type {
  BundleEventRow,
  InsightsApi,
  InsightsBundleEventFilter,
} from "@hot-updater/plugin-insights/server";
import { describe, expect, it } from "vitest";

import { expectInsightsIndex } from "./expectInsightsIndex";
import { createBundleEventRowFixture } from "./fixtures";
import { insights11TestPlugin, type Insights11TestApi } from "./insights11";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The backfill of a 1.1 server's rows, on one database: `createApi(database,
 * plugin)` serves `plugin`, `insights()` when omitted, over it, and returns
 * its API.
 */
export const registerInsightsBackfillTests = (context: {
  readonly getDatabase: () => unknown;
  readonly createApi: (
    database: unknown,
    plugin?: AnyHotUpdaterPlugin,
  ) => unknown;
}): void => {
  describe("Insights release-ref backfill", () => {
    it("moves a 1.1 server's artifact-keyed events and counts to their releases, once, and again after a 1.1 server writes more", async () => {
      const database = context.getDatabase();
      const legacy = context.createApi(
        database,
        insights11TestPlugin(),
      ) as Insights11TestApi;
      const api = context.createApi(database) as InsightsApi;
      // Recent hours, so the raw period holds them.
      const base = Date.now() - (Date.now() % HOUR) - 6 * HOUR;
      const artifactA = createBundleEventRowFixture("9850", 0).to_bundle_id;
      const artifactB = createBundleEventRowFixture("9851", 0).to_bundle_id;
      const builtin = createBundleEventRowFixture("9852", 0).to_bundle_id;
      const v3 = "00000000-0000-7000-8000-000000009853";
      const v4 = "00000000-0000-7000-8000-000000009854";
      const v5 = "00000000-0000-7000-8000-000000009855";
      const event = (
        suffix: string,
        at: number,
        installId: string,
        fields: Partial<BundleEventRow>,
      ): BundleEventRow =>
        ({
          ...createBundleEventRowFixture(suffix, base + at),
          install_id: installId,
          ...fields,
        }) as BundleEventRow;
      const crash = (suffix: string, at: number, installId: string) =>
        event(suffix, at, installId, {
          type: "RECOVERED",
          from_bundle_id: artifactA,
          from_release_id: v3,
          to_bundle_id: artifactB,
          to_release_id: v4,
        });
      // v3 and v5 serve one artifact in one channel and platform.
      const onV3 = { to_bundle_id: artifactA, to_release_id: v3 };
      const onV5 = { to_bundle_id: artifactA, to_release_id: v5 };
      const events = [
        event("9860", 0, "backfill-1", onV3),
        event("9861", 1, "backfill-2", onV3),
        crash("9862", HOUR, "backfill-1"),
        // Its download report never arrived: the crash implied it.
        {
          ...crash("9863", HOUR + 1, "backfill-2"),
          metadata: {
            ...createBundleEventRowFixture("9863", 0).metadata,
            implied_download: true,
          },
        } as BundleEventRow,
        event("9864", 2 * HOUR, "backfill-3", onV5),
        event("9865", 2 * HOUR + 1, "backfill-4", onV5),
        event("9866", 2 * HOUR + 2, "backfill-5", onV5),
        // A launch with no release ID keeps the bundle ID it reports.
        event("9867", 3 * HOUR, "backfill-6", { to_bundle_id: builtin }),
      ];
      for (const row of events) await legacy.record(row);

      const scope = { platform: "ios", channel: "production" } as const;
      const count = (filter: InsightsBundleEventFilter) =>
        api.countEvents({
          filter,
          sinceMs: base - DAY,
          beforeReceivedAtMs: base + DAY,
        });
      const launched = (id: string) =>
        ({ ...scope, type: "UPDATE_APPLIED", toReleaseId: id }) as const;
      const crashed = (id: string) =>
        ({ ...scope, type: "RECOVERED", fromReleaseId: id }) as const;
      const downloaded = (id: string) =>
        ({ ...scope, type: "UPDATE_DOWNLOADED", toReleaseId: id }) as const;
      // Before it, release reads find none of the 1.1 rows.
      await expectInsightsIndex(() => count(launched(artifactA)), 5);
      await expect(count(launched(v3))).resolves.toBe(0);

      // Every event that names a release moves; the built-in launch stays.
      await expectInsightsIndex(
        () => api.backfillReleaseRefs({ dryRun: true }),
        { events: 7 },
      );
      await expect(api.backfillReleaseRefs()).resolves.toEqual({ events: 7 });

      await expectInsightsIndex(() => count(launched(v3)), 2);
      await expectInsightsIndex(() => count(launched(v5)), 3);
      await expectInsightsIndex(() => count(crashed(v3)), 2);
      await expectInsightsIndex(() => count(crashed(v5)), 0);
      await expectInsightsIndex(() => count(downloaded(v3)), 1);
      await expectInsightsIndex(() => count(launched(builtin)), 1);
      await expectInsightsIndex(() => count(launched(artifactA)), 0);
      await expectInsightsIndex(() => count(crashed(artifactA)), 0);
      await expectInsightsIndex(() => count(downloaded(artifactA)), 0);
      await expectInsightsIndex(
        () =>
          api
            .listEvents({
              filter: { kind: "bundle", ...crashed(v3) },
              sinceMs: base - DAY,
              beforeReceivedAtMs: base + DAY,
              limit: 10,
            })
            .then((rows) => rows.map(({ install_id }) => install_id)),
        ["backfill-2", "backfill-1"],
      );
      // Run again, it moves nothing.
      await expectInsightsIndex(
        () => api.backfillReleaseRefs({ dryRun: true }),
        { events: 0 },
      );
      await expect(api.backfillReleaseRefs()).resolves.toEqual({ events: 0 });

      // A 1.1 server still running writes by artifact: release reads miss
      // its event until the backfill runs again.
      await legacy.record(event("9868", 4 * HOUR, "backfill-7", onV5));
      await expectInsightsIndex(() => count(launched(artifactA)), 1);
      await expect(count(launched(v5))).resolves.toBe(3);
      await expectInsightsIndex(
        () => api.backfillReleaseRefs({ dryRun: true }),
        { events: 1 },
      );
      await expect(api.backfillReleaseRefs()).resolves.toEqual({ events: 1 });
      await expectInsightsIndex(() => count(launched(v5)), 4);
      await expectInsightsIndex(() => count(launched(artifactA)), 0);
    });

    it("moves a day of more stale events than one transaction of the store holds", async () => {
      const database = context.getDatabase();
      const legacy = context.createApi(
        database,
        insights11TestPlugin(),
      ) as Insights11TestApi;
      const api = context.createApi(database) as InsightsApi;
      const base = Date.now() - (Date.now() % HOUR) - 2 * HOUR;
      const release = "00000000-0000-7000-8000-000000009880";
      const artifact = createBundleEventRowFixture("9881", 0).to_bundle_id;
      // More than one batch, and more rewrites than DynamoDB's 100 items
      // take in one transaction with their index copies and counts.
      const count = 40;
      for (let n = 0; n < count; n += 1) {
        await legacy.record({
          ...createBundleEventRowFixture(String(9900 + n), base + n),
          install_id: `backfill-day-${n}`,
          to_bundle_id: artifact,
          to_release_id: release,
        } as BundleEventRow);
      }

      await expect(api.backfillReleaseRefs()).resolves.toEqual({
        events: count,
      });

      await expectInsightsIndex(
        () =>
          api.countEvents({
            filter: {
              platform: "ios",
              channel: "production",
              type: "UPDATE_APPLIED",
              toReleaseId: release,
            },
            sinceMs: base - DAY,
            beforeReceivedAtMs: base + DAY,
          }),
        count,
      );
      await expect(api.backfillReleaseRefs({ dryRun: true })).resolves.toEqual({
        events: 0,
      });
    });
  });
};

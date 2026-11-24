import {
  type AnyHotUpdaterPlugin,
  defineAggregate,
  definePlugin,
  defineTable,
} from "@hot-updater/plugin-core";
import type {
  BundleEventRow,
  InsightsApi,
  InsightsBundleEventFilter,
} from "@hot-updater/plugin-insights/server";
import { describe, expect, it } from "vitest";

import { expectInsightsIndex } from "./expectInsightsIndex";
import { createBundleEventRowFixture } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The refs a 1.1 server wrote: each names the artifact. A frozen copy of
 * 1.1's `bundleRefsOf`, so the fixture writes rows as 1.1 did.
 */
const artifactRefsOf = (row: BundleEventRow): string[] => {
  const metadata = row.metadata as {
    readonly late?: true;
    readonly failure?: { readonly stage?: string };
    readonly change?: { readonly kinds?: readonly string[] };
  };
  if (metadata.late === true) return [];
  if (row.type === "UPDATE_FAILED" && metadata.failure?.stage === "check") {
    return [];
  }
  if (row.type === "RECOVERED") return [`from:${row.from_bundle_id}`];
  if (row.type === "UNCHANGED") {
    const kinds = metadata.change?.kinds ?? [];
    return kinds.includes("bundle") &&
      !kinds.includes("first_seen") &&
      row.to_release_id !== null
      ? [`on:${row.to_bundle_id}`]
      : [];
  }
  return [`to:${row.to_bundle_id}`];
};

/**
 * Insights' raw events and outcome counters as 1.1 declared them, which a
 * 1.1 server writes: the same tables, columns, and indexes, with refs that
 * name the artifact.
 */
const insights11Schema = {
  bundle_events: defineTable(
    {
      id: { type: "string", maxLength: 36 },
      type: { type: "string", maxLength: 32 },
      install_id: { type: "string", maxLength: 255 },
      user_id: { type: "string", maxLength: 255, required: false },
      from_release_id: { type: "string", maxLength: 36, required: false },
      from_bundle_id: { type: "string", maxLength: 36, required: false },
      to_release_id: { type: "string", maxLength: 36, required: false },
      to_bundle_id: { type: "string", maxLength: 36 },
      platform: { type: "string", maxLength: 16 },
      app_version: { type: "string" },
      channel: { type: "string" },
      metadata: { type: "json" },
      received_at_ms: { type: "integer" },
    },
    {
      key: ["id"],
      derived: {
        day: {
          type: "integer",
          compute: (row) => row.received_at_ms - (row.received_at_ms % DAY),
        },
        movement_install_id: {
          type: "string",
          compute: (row) => row.install_id,
        },
        bundle_ref: {
          type: "string",
          multi: true,
          compute: (row) => artifactRefsOf(row as unknown as BundleEventRow),
        },
      },
      indexes: {
        movementsByInstall: {
          eq: ["movement_install_id"],
          sort: ["received_at_ms"],
        },
        byBundle: {
          eq: ["platform", "channel", "type", "bundle_ref", "day"],
          sort: ["received_at_ms"],
        },
        byDay: { eq: ["day"], sort: ["received_at_ms"] },
      },
      retention: { field: "day", days: 90 },
    },
  ),
  insights_outcomes: defineAggregate(
    {
      platform: { type: "string", maxLength: 16 },
      channel: { type: "string" },
      type: { type: "string", maxLength: 32 },
      bundle_ref: { type: "string", maxLength: 41 },
      bucket_start_ms: { type: "integer" },
    },
    {
      key: ["platform", "channel", "type", "bundle_ref", "bucket_start_ms"],
      counters: ["events"],
      shards: 8,
      batched: true,
      indexes: {
        byRef: {
          eq: ["platform", "channel", "type", "bundle_ref"],
          sort: ["bucket_start_ms"],
        },
      },
      retention: { field: "bucket_start_ms", days: 90 },
    },
  ),
} as const;

/**
 * A 1.1 server's `insights()` as far as the backfill reads it: it stores
 * events and counts their outcome hours by artifact, as 1.1's
 * `countOutcome` did. It stands in for the official plugin, so it takes its
 * id and brand.
 */
const insights11 = (): AnyHotUpdaterPlugin =>
  Object.defineProperty(
    definePlugin({
      id: "insights",
      namespace: false,
      schemaVersion: "1.0.0",
      schema: insights11Schema,
      init: ({ db }) => ({
        api: {
          record: (event: BundleEventRow) =>
            db.transaction(async (tx) => {
              tx.create("bundle_events", event as never);
              const hour = (type: string, ref: string) =>
                tx.aggregate(
                  "insights_outcomes",
                  {
                    platform: event.platform,
                    channel: event.channel,
                    type,
                    bundle_ref: ref,
                    bucket_start_ms:
                      event.received_at_ms - (event.received_at_ms % HOUR),
                  },
                  { events: 1 },
                  { shardBy: event.install_id },
                );
              for (const ref of artifactRefsOf(event)) hour(event.type, ref);
              if (
                (event.metadata as { implied_download?: true })
                  .implied_download === true
              ) {
                hour(
                  "UPDATE_DOWNLOADED",
                  `to:${event.type === "RECOVERED" ? event.from_bundle_id : event.to_bundle_id}`,
                );
              }
              tx.aggregate(
                "insights_outcomes",
                {
                  platform: "*",
                  channel: "",
                  type: "",
                  bundle_ref: "",
                  bucket_start_ms:
                    event.received_at_ms - (event.received_at_ms % DAY),
                },
                { events: 1 },
                { shardBy: event.install_id },
              );
            }),
        },
      }),
    }),
    Symbol.for("@hot-updater/server/official-plugin"),
    { value: true },
  );

type Insights11Api = {
  readonly record: (event: BundleEventRow) => Promise<void>;
};

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
      const legacy = context.createApi(database, insights11()) as Insights11Api;
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
  });
};

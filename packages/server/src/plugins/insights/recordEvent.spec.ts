import { DatabaseSync } from "node:sqlite";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  countInsightsDistinct,
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
} from "@hot-updater/plugin-core/internal";
import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as engine from "../../database";
import type { HotUpdaterDatabase } from "../../database/database";
import { createSqlAdapter } from "../../database/sql/sqlAdapter";
import { sqliteExecutor } from "../../database/sql/sqlTestExecutors";
import {
  insights,
  insightsIdentity,
  type InsightsIdentityParts,
  type InsightsSchema,
} from "./index";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 23, 10, 15);
const hour = (ms: number) => ms - (ms % HOUR);

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const event = (
  n: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: uuid(n),
    type: "UPDATE_APPLIED",
    install_id: "install-1",
    user_id: "user-1",
    from_release_id: "release-1",
    from_bundle_id: "bundle-1",
    to_release_id: "release-2",
    to_bundle_id: "bundle-2",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      username: null,
      cohort: "1",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: T,
    ...overrides,
  }) as BundleEventRow;

const backends: [string, () => DatabaseAdapter][] = [
  ["memory", () => createMemoryAdapter()],
  [
    "SQLite",
    () =>
      createSqlAdapter({
        executor: sqliteExecutor(new DatabaseSync(":memory:")),
      }),
  ],
];

const identity = (
  parts: Partial<InsightsIdentityParts> &
    Pick<InsightsIdentityParts, "periodKind">,
) =>
  insightsIdentity({
    scopeKind: "channel",
    releaseKind: "all",
    releaseId: "",
    channel: "production",
    platform: "ios",
    appVersionKind: "all",
    appVersion: "",
    ...parts,
  });

describe.each(backends)("insights recordEvent on %s", (_name, adapter) => {
  const setup = async (wrap = (inner: DatabaseAdapter) => inner) => {
    const harness = await createPluginTestHarness(insights(), {
      engine,
      adapter: wrap(adapter()),
    });
    const db = harness.db as HotUpdaterDatabase<InsightsSchema>;
    const at = (key: string, bucket: number) => ({
      index: "window" as const,
      where: { identity: key },
      range: { gte: bucket, lte: bucket },
      limit: 100,
    });
    const overview = async (key: string, bucket: number) =>
      (await db.findAggregates("insights_overview", at(key, bucket))).rows[0];
    const sketch = async (key: string, bucket: number) =>
      (await db.findAggregates("insights_sketches", at(key, bucket))).rows[0];
    const distribution = async () =>
      (
        await db.findAggregates("insights_distribution", {
          index: "byScope",
          where: { channel: "production", platform: "ios" },
          limit: 100,
        })
      ).rows;
    const byBundle = async (
      field: "from_bundle_id" | "to_bundle_id",
      bundleId: string,
      type: string,
    ) =>
      (
        await db.findAggregates("insights_latest_by_bundle", {
          index: "byBundle",
          where: {
            platform: "ios",
            channel: "production",
            bundle_field: field,
            bundle_id: bundleId,
            type,
          },
          limit: 100,
        })
      ).rows;
    const outcomes = async (type: string, ref: string) =>
      (
        await db.findAggregates("insights_outcomes", {
          index: "byRef",
          where: {
            platform: "ios",
            channel: "production",
            type,
            bundle_ref: ref,
          },
          limit: 100,
        })
      ).rows;
    return {
      ...harness,
      db,
      overview,
      sketch,
      distribution,
      byBundle,
      outcomes,
    };
  };

  it("records the event with derived keys, the head, gauges, counters, and sketches", async () => {
    const { api, db, overview, sketch, distribution, byBundle, outcomes } =
      await setup();
    await api.recordEvent(event(1));

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({
      day: T - (T % DAY),
      movement_install_id: "install-1",
      bundle_ref: ["from:bundle-1", "to:bundle-2"],
    });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toEqual({
      ...event(1),
      current_release_id: "release-2",
      _v: 0,
    });
    await expect(distribution()).resolves.toEqual([
      {
        channel: "production",
        platform: "ios",
        app_version: "1.0.0",
        release_id: "release-2",
        bucket_start_ms: hour(T),
        latest_installations: 1,
      },
    ]);
    for (const [field, bundle] of [
      ["from_bundle_id", "bundle-1"],
      ["to_bundle_id", "bundle-2"],
    ] as const) {
      await expect(
        byBundle(field, bundle, "UPDATE_APPLIED"),
      ).resolves.toMatchObject([{ installations: 1 }]);
    }
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([{ bucket_start_ms: hour(T), events: 1 }]);

    const release = { scopeKind: "release", releaseKind: "specific" } as const;
    const counters = { downloads: 0, launches: 1, failed_launches: 0 };
    await expect(
      overview(
        identity({
          ...release,
          releaseId: "release-2",
          periodKind: "lifetime",
        }),
        0,
      ),
    ).resolves.toMatchObject(counters);
    for (const [periodKind, bucket] of [
      ["hour", hour(T)],
      ["day", T - (T % DAY)],
    ] as const) {
      await expect(
        overview(identity({ periodKind }), bucket),
      ).resolves.toMatchObject(counters);
      const launches = await sketch(identity({ periodKind }), bucket);
      expect(countInsightsDistinct(launches!.launch_users)).toBe(1);
      for (const platform of ["ios", "all"] as const) {
        const usage = await sketch(
          identity({
            scopeKind: "usage",
            platform,
            appVersionKind: "specific",
            appVersion: "1.0.0",
            periodKind,
          }),
          bucket,
        );
        expect(countInsightsDistinct(usage!.activity_users)).toBe(1);
      }
    }
  });

  it("changes nothing for a repeated id, even with another payload", async () => {
    const { api, db, outcomes } = await setup();
    await api.recordEvent(event(1));
    await api.recordEvent(
      event(1, { install_id: "install-2", received_at_ms: T + HOUR }),
    );

    await expect(
      db.findOne("bundle_events", { id: uuid(1) }),
    ).resolves.toMatchObject({ install_id: "install-1" });
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-2" }),
    ).resolves.toBeNull();
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([{ events: 1 }]);
  });

  it("moves the head only for a newer event and deletes gauge rows that reach zero", async () => {
    const { api, db, distribution, byBundle, outcomes } = await setup();
    await api.recordEvent(event(1));
    await api.recordEvent(
      event(2, {
        type: "UPDATE_DOWNLOADED",
        user_id: null,
        from_release_id: "release-2",
        from_bundle_id: "bundle-2",
        to_release_id: "release-3",
        to_bundle_id: "bundle-3",
        received_at_ms: T + 2 * HOUR,
      }),
    );
    await api.recordEvent(event(3, { received_at_ms: T + HOUR }));

    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({
      id: uuid(2),
      user_id: null,
      type: "UPDATE_DOWNLOADED",
      current_release_id: "release-2",
    });
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-2",
        bucket_start_ms: hour(T + 2 * HOUR),
        latest_installations: 1,
      },
    ]);
    await expect(
      byBundle("to_bundle_id", "bundle-2", "UPDATE_APPLIED"),
    ).resolves.toEqual([]);
    await expect(
      byBundle("to_bundle_id", "bundle-3", "UPDATE_DOWNLOADED"),
    ).resolves.toMatchObject([{ installations: 1 }]);
    await expect(
      outcomes("UPDATE_APPLIED", "to:bundle-2"),
    ).resolves.toMatchObject([
      { bucket_start_ms: hour(T), events: 1 },
      { bucket_start_ms: hour(T + HOUR), events: 1 },
    ]);

    await api.recordEvent(event(4, { received_at_ms: T + 2 * HOUR }));
    await expect(
      db.findOne("bundle_event_heads", { install_id: "install-1" }),
    ).resolves.toMatchObject({ id: uuid(4), type: "UPDATE_APPLIED" });
    await expect(distribution()).resolves.toMatchObject([
      {
        release_id: "release-2",
        bucket_start_ms: hour(T + 2 * HOUR),
        latest_installations: 1,
      },
    ]);
  });

  it("reads the event and head in one round, gauge and sketch rows in a second, and writes once", async () => {
    const calls: string[] = [];
    const { api, measureReads } = await setup((inner) => ({
      ...inner,
      get: async (table, keys) => {
        calls.push(`get ${table.name}`);
        return inner.get(table, keys);
      },
      write: async (ops: readonly WriteOp[]) => {
        calls.push("write");
        return inner.write(ops);
      },
    }));
    const measured = await measureReads(() => api.recordEvent(event(1)));

    expect(measured.adapter.queries).toBe(0);
    expect(calls).toEqual([
      "get bundle_events",
      "get bundle_event_heads",
      "get insights_sketches",
      "get insights_distribution",
      "get insights_latest_by_bundle",
      "write",
    ]);
  });

  it("serializes events per installation and keeps gauges exact under concurrency", async () => {
    const { api, db, distribution } = await setup();
    const installs = ["a", "b", "c", "d"];
    const events = installs.flatMap((install, position) =>
      [0, 1, 2].map((step) =>
        event(position * 10 + step + 1, {
          install_id: `install-${install}`,
          received_at_ms: T + ((step * 7 + position) % 3) * HOUR,
        }),
      ),
    );
    await Promise.all(events.map((row) => api.recordEvent(row)));

    for (const install of installs) {
      const latest = events
        .filter((row) => row.install_id === `install-${install}`)
        .toSorted(
          (left, right) =>
            left.received_at_ms - right.received_at_ms ||
            (left.id < right.id ? -1 : 1),
        )
        .at(-1)!;
      await expect(
        db.findOne("bundle_event_heads", { install_id: `install-${install}` }),
      ).resolves.toMatchObject({ id: latest.id });
    }
    const counted = (await distribution()).reduce(
      (sum, row) => sum + row.latest_installations,
      0,
    );
    expect(counted).toBe(installs.length);
  });
});

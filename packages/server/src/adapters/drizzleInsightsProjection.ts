import type { ReleaseReference } from "@hot-updater/plugin-core";
import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
} from "@hot-updater/plugin-core/internal";
import type {
  InsightsProjectionBackend,
  PreparedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import type { DrizzleProvider } from "./drizzle";
import {
  getDrizzleColumn,
  getDrizzleTable,
  recordDrizzleInsights,
} from "./drizzleCrud";
import type { DrizzleDB } from "./drizzleLazyDB";
import { insightsSqlKey, prepareInsightsSqlKeys } from "./insightsSqlKeys";

type AggregateQuery = {
  readonly findFirst: (args?: unknown) => Promise<
    Record<string, unknown> | undefined
  > & {
    readonly sync?: () => Record<string, unknown> | undefined;
  };
  readonly findMany: (args?: unknown) => Promise<Record<string, unknown>[]> & {
    readonly sync?: () => Record<string, unknown>[];
  };
};

class ProjectionConflictError extends Error {}

const query = (
  db: DrizzleDB,
  name: keyof DrizzleDB["query"],
): AggregateQuery => {
  const value = db.query[name];
  if (!value) throw new Error(`Drizzle schema is missing ${name}.`);
  return value as AggregateQuery;
};

const count = (value: unknown): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Drizzle returned an invalid Insights aggregate.");
  }
  return result;
};

const affectedRows = (result: unknown): number | undefined => {
  if (typeof result !== "object" || result === null) return undefined;
  for (const field of [
    "rowCount",
    "affectedRows",
    "rowsAffected",
    "changes",
    "count",
  ]) {
    const value = Reflect.get(result, field);
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
  }
  if (Array.isArray(result)) return affectedRows(result[0]);
  return undefined;
};

const syncFirst = (
  db: DrizzleDB,
  name: keyof DrizzleDB["query"],
  args: unknown,
): Record<string, unknown> | undefined => {
  const result = query(db, name).findFirst(args);
  if (typeof result.sync !== "function") {
    throw new Error("Synchronous Drizzle Insights query unsupported.");
  }
  return result.sync();
};

const run = (mutation: { readonly run?: () => unknown }): unknown => {
  if (!mutation.run) {
    throw new Error("Synchronous Drizzle Insights mutation unsupported.");
  }
  return mutation.run();
};

type Delta = {
  release: ReleaseReference;
  active: number;
  pending: number;
  downloaded: number;
  recovered: number;
};

const releaseDeltas = (prepared: PreparedInsightsEvent) => {
  const deltas = new Map<string, Delta>();
  const add = (
    release: ReleaseReference,
    metric: "active" | "pending" | "downloaded" | "recovered",
    value: number,
  ) => {
    const key = insightsReleaseKey(release);
    const delta = deltas.get(key) ?? {
      release,
      active: 0,
      pending: 0,
      downloaded: 0,
      recovered: 0,
    };
    delta[metric] += value;
    deltas.set(key, delta);
  };
  for (const delta of prepared.currentDeltas) {
    add(delta.release, delta.metric, delta.delta);
  }
  if (prepared.firstLifetime !== null) {
    add(prepared.firstLifetime.release, prepared.firstLifetime.metric, 1);
  }
  return deltas;
};

const commitSynchronousSqliteEvent = (
  transaction: DrizzleDB,
  prepared: PreparedInsightsEvent,
  keys: ReadonlyMap<string, string>,
) => {
  const states = getDrizzleTable(transaction, "insights_install_states");
  const current = syncFirst(transaction, "insights_install_states", {
    where: eq(
      getDrizzleColumn(states, "install_id"),
      prepared.event.install_id,
    ),
  });
  if (String(current?.revision ?? 0) !== prepared.expectedRevision) {
    return { status: "conflict" as const };
  }
  const events = getDrizzleTable(transaction, "bundle_events");
  const existing = syncFirst(transaction, "bundle_events", {
    where: eq(getDrizzleColumn(events, "id"), prepared.event.id),
  });
  if (existing) return { status: "duplicate" as const };

  const lifetime = prepared.firstLifetime;
  const markers = getDrizzleTable(transaction, "insights_lifetime_markers");
  if (
    lifetime !== null &&
    syncFirst(transaction, "insights_lifetime_markers", {
      where: eq(
        getDrizzleColumn(markers, "marker_key"),
        keys.get(insightsLifetimeMarkerKey(lifetime))!,
      ),
    })
  ) {
    return { status: "conflict" as const };
  }

  recordDrizzleInsights(
    transaction,
    "sqlite",
    { event: prepared.event },
    true,
    "error",
  );
  if (current) {
    const updated = run(
      transaction
        .update(states)
        .set({
          revision: Number(prepared.expectedRevision) + 1,
          state: prepared.nextState,
        })
        .where(
          and(
            eq(
              getDrizzleColumn(states, "install_id"),
              prepared.event.install_id,
            ),
            eq(
              getDrizzleColumn(states, "revision"),
              Number(prepared.expectedRevision),
            ),
          ),
        ),
    );
    if (affectedRows(updated) !== 1) throw new ProjectionConflictError();
  } else {
    run(
      transaction.insert(states).values({
        install_id: prepared.event.install_id,
        revision: 1,
        state: prepared.nextState,
      }),
    );
  }

  if (lifetime !== null) {
    run(
      transaction.insert(markers).values({
        marker_key: keys.get(insightsLifetimeMarkerKey(lifetime))!,
        release_id: lifetime.release.releaseId,
        platform: lifetime.release.platform,
        channel: lifetime.release.channel,
        install_id: lifetime.installId,
        metric: lifetime.metric,
      }),
    );
  }

  const summaries = getDrizzleTable(transaction, "insights_release_summaries");
  for (const [logicalKey, delta] of releaseDeltas(prepared)) {
    const key = keys.get(logicalKey)!;
    const ignored = transaction
      .insert(summaries)
      .values({
        release_key: key,
        release_id: delta.release.releaseId,
        platform: delta.release.platform,
        channel: delta.release.channel,
        active_installations: 0,
        pending_installations: 0,
        downloaded_installations: 0,
        recovered_installations: 0,
      })
      .onConflictDoNothing?.();
    if (!ignored) throw new Error("Drizzle conflict insert unsupported.");
    run(ignored);
    run(
      transaction
        .update(summaries)
        .set({
          active_installations: sql`${getDrizzleColumn(summaries, "active_installations")} + ${delta.active}`,
          pending_installations: sql`${getDrizzleColumn(summaries, "pending_installations")} + ${delta.pending}`,
          downloaded_installations: sql`${getDrizzleColumn(summaries, "downloaded_installations")} + ${delta.downloaded}`,
          recovered_installations: sql`${getDrizzleColumn(summaries, "recovered_installations")} + ${delta.recovered}`,
        })
        .where(eq(getDrizzleColumn(summaries, "release_key"), key)),
    );
  }

  if (prepared.hourly !== null) {
    const value = prepared.hourly;
    const buckets = getDrizzleTable(transaction, "insights_hourly_activity");
    const data = {
      bucket_key: keys.get(
        insightsHourlyBucketKey(value.release, value.hourStartMs),
      )!,
      release_id: value.release.releaseId,
      platform: value.release.platform,
      channel: value.release.channel,
      hour_start_ms: value.hourStartMs,
      downloaded_reports: 0,
      applied_reports: 0,
      recovered_reports: 0,
    };
    const ignored = transaction
      .insert(buckets)
      .values(data)
      .onConflictDoNothing?.();
    if (!ignored) throw new Error("Drizzle conflict insert unsupported.");
    run(ignored);
    run(
      transaction
        .update(buckets)
        .set({
          downloaded_reports: sql`${getDrizzleColumn(buckets, "downloaded_reports")} + ${value.metric === "downloaded" ? 1 : 0}`,
          applied_reports: sql`${getDrizzleColumn(buckets, "applied_reports")} + ${value.metric === "applied" ? 1 : 0}`,
          recovered_reports: sql`${getDrizzleColumn(buckets, "recovered_reports")} + ${value.metric === "recovered" ? 1 : 0}`,
        })
        .where(eq(getDrizzleColumn(buckets, "bucket_key"), data.bucket_key)),
    );
  }
  return { status: "committed" as const };
};

export const createDrizzleInsightsProjection = (
  db: DrizzleDB,
  provider: DrizzleProvider,
): InsightsProjectionBackend => ({
  async readRecordContext({ installId, lifetimeKey }) {
    const states = getDrizzleTable(db, "insights_install_states");
    const markers = getDrizzleTable(db, "insights_lifetime_markers");
    const markerKey =
      lifetimeKey === null
        ? null
        : await insightsSqlKey(insightsLifetimeMarkerKey(lifetimeKey));
    const [state, marker] = await Promise.all([
      query(db, "insights_install_states").findFirst({
        where: eq(getDrizzleColumn(states, "install_id"), installId),
      }),
      lifetimeKey === null
        ? undefined
        : query(db, "insights_lifetime_markers").findFirst({
            where: eq(getDrizzleColumn(markers, "marker_key"), markerKey!),
          }),
    ]);
    return {
      revision: String(state?.revision ?? 0),
      state: typeof state?.state === "string" ? state.state : null,
      lifetimeExists: marker !== undefined,
    };
  },
  async commitPreparedEvent(prepared: PreparedInsightsEvent) {
    if (!db.transaction) {
      throw new Error("Drizzle Insights aggregation requires transactions.");
    }
    const keys = await prepareInsightsSqlKeys(prepared);
    try {
      if (db.resultKind === "sync") {
        if (provider !== "sqlite") {
          throw new Error("Synchronous Drizzle Insights requires SQLite.");
        }
        return await db.transaction((transaction) =>
          commitSynchronousSqliteEvent(transaction, prepared, keys),
        );
      }
      return await db.transaction(async (transaction) => {
        const states = getDrizzleTable(transaction, "insights_install_states");
        if (provider !== "sqlite") {
          if (!transaction.execute) {
            throw new Error("Drizzle Insights locking requires SQL execution.");
          }
          await transaction.execute(
            sql`select ${getDrizzleColumn(states, "install_id")} from ${states} where ${getDrizzleColumn(states, "install_id")} = ${prepared.event.install_id} for update`,
          );
        }
        const current = await query(
          transaction,
          "insights_install_states",
        ).findFirst({
          where: eq(
            getDrizzleColumn(states, "install_id"),
            prepared.event.install_id,
          ),
        });
        if (String(current?.revision ?? 0) !== prepared.expectedRevision) {
          return { status: "conflict" as const };
        }
        const existing = await query(transaction, "bundle_events").findFirst({
          where: eq(
            getDrizzleColumn(
              getDrizzleTable(transaction, "bundle_events"),
              "id",
            ),
            prepared.event.id,
          ),
        });
        if (existing) return { status: "duplicate" as const };
        if (prepared.firstLifetime !== null) {
          const markers = getDrizzleTable(
            transaction,
            "insights_lifetime_markers",
          );
          const marker = await query(
            transaction,
            "insights_lifetime_markers",
          ).findFirst({
            where: eq(
              getDrizzleColumn(markers, "marker_key"),
              keys.get(insightsLifetimeMarkerKey(prepared.firstLifetime))!,
            ),
          });
          if (marker) return { status: "conflict" as const };
        }
        await recordDrizzleInsights(
          transaction,
          provider,
          { event: prepared.event },
          true,
          "error",
        );
        if (current) {
          const updated = await transaction
            .update(states)
            .set({
              revision: Number(prepared.expectedRevision) + 1,
              state: prepared.nextState,
            })
            .where(
              and(
                eq(
                  getDrizzleColumn(states, "install_id"),
                  prepared.event.install_id,
                ),
                eq(
                  getDrizzleColumn(states, "revision"),
                  Number(prepared.expectedRevision),
                ),
              ),
            )
            .execute();
          if (affectedRows(updated) !== 1) {
            throw new ProjectionConflictError();
          }
        } else {
          await transaction
            .insert(states)
            .values({
              install_id: prepared.event.install_id,
              revision: 1,
              state: prepared.nextState,
            })
            .execute();
        }
        const deltas = releaseDeltas(prepared);
        if (prepared.firstLifetime !== null) {
          const lifetime = prepared.firstLifetime;
          await transaction
            .insert(getDrizzleTable(transaction, "insights_lifetime_markers"))
            .values({
              marker_key: keys.get(insightsLifetimeMarkerKey(lifetime))!,
              release_id: lifetime.release.releaseId,
              platform: lifetime.release.platform,
              channel: lifetime.release.channel,
              install_id: lifetime.installId,
              metric: lifetime.metric,
            })
            .execute();
        }
        const summaries = getDrizzleTable(
          transaction,
          "insights_release_summaries",
        );
        for (const [logicalKey, delta] of deltas) {
          const key = keys.get(logicalKey)!;
          const insert = transaction.insert(summaries).values({
            release_key: key,
            release_id: delta.release.releaseId,
            platform: delta.release.platform,
            channel: delta.release.channel,
            active_installations: 0,
            pending_installations: 0,
            downloaded_installations: 0,
            recovered_installations: 0,
          });
          const ignored =
            provider === "mysql"
              ? transaction.insert(summaries).ignore?.().values({
                  release_key: key,
                  release_id: delta.release.releaseId,
                  platform: delta.release.platform,
                  channel: delta.release.channel,
                  active_installations: 0,
                  pending_installations: 0,
                  downloaded_installations: 0,
                  recovered_installations: 0,
                })
              : insert.onConflictDoNothing?.();
          if (!ignored) throw new Error("Drizzle conflict insert unsupported.");
          await ignored.execute();
          await transaction
            .update(summaries)
            .set({
              active_installations: sql`${getDrizzleColumn(summaries, "active_installations")} + ${delta.active}`,
              pending_installations: sql`${getDrizzleColumn(summaries, "pending_installations")} + ${delta.pending}`,
              downloaded_installations: sql`${getDrizzleColumn(summaries, "downloaded_installations")} + ${delta.downloaded}`,
              recovered_installations: sql`${getDrizzleColumn(summaries, "recovered_installations")} + ${delta.recovered}`,
            })
            .where(eq(getDrizzleColumn(summaries, "release_key"), key))
            .execute();
        }
        if (prepared.hourly !== null) {
          const value = prepared.hourly;
          const buckets = getDrizzleTable(
            transaction,
            "insights_hourly_activity",
          );
          const data = {
            bucket_key: keys.get(
              insightsHourlyBucketKey(value.release, value.hourStartMs),
            )!,
            release_id: value.release.releaseId,
            platform: value.release.platform,
            channel: value.release.channel,
            hour_start_ms: value.hourStartMs,
            downloaded_reports: 0,
            applied_reports: 0,
            recovered_reports: 0,
          };
          const insert = transaction.insert(buckets).values(data);
          const ignored =
            provider === "mysql"
              ? transaction.insert(buckets).ignore?.().values(data)
              : insert.onConflictDoNothing?.();
          if (!ignored) throw new Error("Drizzle conflict insert unsupported.");
          await ignored.execute();
          await transaction
            .update(buckets)
            .set({
              downloaded_reports: sql`${getDrizzleColumn(buckets, "downloaded_reports")} + ${value.metric === "downloaded" ? 1 : 0}`,
              applied_reports: sql`${getDrizzleColumn(buckets, "applied_reports")} + ${value.metric === "applied" ? 1 : 0}`,
              recovered_reports: sql`${getDrizzleColumn(buckets, "recovered_reports")} + ${value.metric === "recovered" ? 1 : 0}`,
            })
            .where(eq(getDrizzleColumn(buckets, "bucket_key"), data.bucket_key))
            .execute();
        }
        return { status: "committed" as const };
      });
    } catch (error) {
      if (error instanceof ProjectionConflictError) {
        return { status: "conflict" };
      }
      const direct =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "code")
          : undefined;
      const cause =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "cause")
          : undefined;
      const nested =
        typeof cause === "object" && cause !== null
          ? Reflect.get(cause, "code")
          : undefined;
      if (
        ![
          "23505",
          "1062",
          "SQLITE_CONSTRAINT_UNIQUE",
          "SQLITE_CONSTRAINT_PRIMARYKEY",
        ].includes(String(direct ?? nested))
      ) {
        throw error;
      }
      const duplicate = await query(db, "bundle_events").findFirst({
        where: eq(
          getDrizzleColumn(getDrizzleTable(db, "bundle_events"), "id"),
          prepared.event.id,
        ),
      });
      return {
        status: duplicate ? ("duplicate" as const) : ("conflict" as const),
      };
    }
  },
  async getReleaseActivity(input) {
    const summaries = getDrizzleTable(db, "insights_release_summaries");
    const buckets = getDrizzleTable(db, "insights_hourly_activity");
    const keys = await Promise.all(
      input.releases.map((release) =>
        insightsSqlKey(insightsReleaseKey(release)),
      ),
    );
    const summaryRows = await query(db, "insights_release_summaries").findMany({
      where: inArray(getDrizzleColumn(summaries, "release_key"), keys),
    });
    const pointRows =
      input.timeRange === undefined
        ? []
        : await query(db, "insights_hourly_activity").findMany({
            where: and(
              or(
                ...input.releases.map((release) =>
                  and(
                    eq(getDrizzleColumn(buckets, "platform"), release.platform),
                    eq(getDrizzleColumn(buckets, "channel"), release.channel),
                    eq(
                      getDrizzleColumn(buckets, "release_id"),
                      release.releaseId,
                    ),
                  ),
                ),
              ),
              gte(
                getDrizzleColumn(buckets, "hour_start_ms"),
                input.timeRange.start,
              ),
              lt(
                getDrizzleColumn(buckets, "hour_start_ms"),
                input.timeRange.end,
              ),
            ),
            orderBy: asc(getDrizzleColumn(buckets, "hour_start_ms")),
          });
    const summaryByKey = new Map(
      summaryRows.map((row) => [String(row.release_key), row]),
    );
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release, index) => {
        const key = keys[index]!;
        const summary = summaryByKey.get(key);
        return {
          release,
          summary: {
            activeInstallations: count(summary?.active_installations),
            pendingInstallations: count(summary?.pending_installations),
            downloadedInstallations: count(summary?.downloaded_installations),
            recoveredInstallations: count(summary?.recovered_installations),
          },
          ...(input.timeRange === undefined
            ? {}
            : {
                series: pointRows
                  .filter(
                    (row) =>
                      row.release_id === release.releaseId &&
                      row.platform === release.platform &&
                      row.channel === release.channel,
                  )
                  .map((row) => ({
                    startMs: count(row.hour_start_ms),
                    downloadedReports: count(row.downloaded_reports),
                    appliedReports: count(row.applied_reports),
                    recoveredReports: count(row.recovered_reports),
                  })),
              }),
          measuredAtMs: Date.now(),
        };
      }),
    };
  },
});

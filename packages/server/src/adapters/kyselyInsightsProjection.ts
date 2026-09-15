import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
} from "@hot-updater/plugin-core/internal";
import type {
  InsightsProjectionBackend,
  PreparedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import type { ORMSQLProvider } from "../db/types";
import { insightsSqlKey, prepareInsightsSqlKeys } from "./insightsSqlKeys";
import { recordKyselyInsights } from "./kyselyCrud";

type Provider = Exclude<ORMSQLProvider, "mssql">;

class ProjectionConflictError extends Error {}

const insertIgnore = (
  executor: QueryExecutorProvider,
  provider: Provider,
  table: string,
  values: Readonly<Record<string, unknown>>,
) => {
  const entries = Object.entries(values);
  const insert = sql`insert into ${sql.table(table)} (${sql.join(
    entries.map(([key]) => sql.ref(key)),
  )}) values (${sql.join(entries.map(([, value]) => value))})`;
  return (
    provider === "mysql"
      ? sql`insert ignore into ${sql.table(table)} (${sql.join(
          entries.map(([key]) => sql.ref(key)),
        )}) values (${sql.join(entries.map(([, value]) => value))})`
      : provider === "sqlite"
        ? sql`insert or ignore into ${sql.table(table)} (${sql.join(
            entries.map(([key]) => sql.ref(key)),
          )}) values (${sql.join(entries.map(([, value]) => value))})`
        : sql`${insert} on conflict do nothing`
  ).execute(executor);
};

const rows = <T>(result: { readonly rows: readonly T[] }): readonly T[] =>
  result.rows;

const commit = async (
  executor: QueryExecutorProvider,
  provider: Provider,
  prepared: PreparedInsightsEvent,
  keys: ReadonlyMap<string, string>,
): Promise<"committed" | "duplicate" | "conflict"> => {
  const lock = provider === "sqlite" ? sql`` : sql` for update`;
  const state = await sql<{ revision: number | string }>`select revision
    from insights_install_states
    where install_id = ${prepared.event.install_id}${lock}`.execute(executor);
  const actual = Number(state.rows[0]?.revision ?? 0);
  if (String(actual) !== prepared.expectedRevision) return "conflict";
  const duplicate = await sql<{ id: string }>`select id from bundle_events
    where id = ${prepared.event.id}`.execute(executor);
  if (duplicate.rows.length > 0) return "duplicate";
  if (prepared.firstLifetime !== null) {
    const marker = await sql<{ marker_key: string }>`select marker_key
      from insights_lifetime_markers
      where marker_key = ${keys.get(insightsLifetimeMarkerKey(prepared.firstLifetime))!}`.execute(
      executor,
    );
    if (marker.rows.length > 0) return "conflict";
  }
  await recordKyselyInsights(
    executor,
    provider,
    { event: prepared.event },
    "error",
  );
  if (actual === 0) {
    await sql`insert into insights_install_states (install_id, revision, state)
      values (${prepared.event.install_id}, 1, ${prepared.nextState})`.execute(
      executor,
    );
  } else {
    const updated = await sql`update insights_install_states
      set revision = ${actual + 1}, state = ${prepared.nextState}
      where install_id = ${prepared.event.install_id}
        and revision = ${actual}`.execute(executor);
    if (Number(updated.numAffectedRows ?? 0) !== 1) {
      throw new ProjectionConflictError();
    }
  }
  if (prepared.firstLifetime !== null) {
    const lifetime = prepared.firstLifetime;
    await sql`insert into insights_lifetime_markers
      (marker_key, release_id, platform, channel, install_id, metric)
      values (${keys.get(insightsLifetimeMarkerKey(lifetime))!}, ${lifetime.release.releaseId},
        ${lifetime.release.platform}, ${lifetime.release.channel},
        ${lifetime.installId}, ${lifetime.metric})`.execute(executor);
  }
  for (const delta of prepared.summaryDeltas) {
    const logicalKey = insightsReleaseKey(delta.release);
    const key = keys.get(logicalKey)!;
    await insertIgnore(executor, provider, "insights_release_summaries", {
      release_key: key,
      release_id: delta.release.releaseId,
      platform: delta.release.platform,
      channel: delta.release.channel,
      active_installations: 0,
      pending_installations: 0,
      downloaded_installations: 0,
      recovered_installations: 0,
    });
    await sql`update insights_release_summaries set
      active_installations = active_installations + ${delta.active},
      pending_installations = pending_installations + ${delta.pending},
      downloaded_installations = downloaded_installations + ${delta.downloaded},
      recovered_installations = recovered_installations + ${delta.recovered}
      where release_key = ${key}`.execute(executor);
  }
  if (prepared.hourly !== null) {
    const value = prepared.hourly;
    const bucketKey = keys.get(
      insightsHourlyBucketKey(value.release, value.hourStartMs),
    )!;
    await insertIgnore(executor, provider, "insights_hourly_activity", {
      bucket_key: bucketKey,
      release_id: value.release.releaseId,
      platform: value.release.platform,
      channel: value.release.channel,
      hour_start_ms: value.hourStartMs,
      downloaded_reports: 0,
      applied_reports: 0,
      recovered_reports: 0,
    });
    await sql`update insights_hourly_activity set
      downloaded_reports = downloaded_reports + ${value.metric === "downloaded" ? 1 : 0},
      applied_reports = applied_reports + ${value.metric === "applied" ? 1 : 0},
      recovered_reports = recovered_reports + ${value.metric === "recovered" ? 1 : 0}
      where bucket_key = ${bucketKey}`.execute(executor);
  }
  return "committed";
};

export const createKyselyInsightsProjection = <TDatabase extends object>(
  db: Kysely<TDatabase>,
  provider: Provider,
): InsightsProjectionBackend => ({
  async readRecordContext({ installId, lifetimeKey }) {
    const markerKey =
      lifetimeKey === null
        ? null
        : await insightsSqlKey(insightsLifetimeMarkerKey(lifetimeKey));
    const [state, marker] = await Promise.all([
      sql<{ revision: number | string; state: string }>`select revision, state
        from insights_install_states where install_id = ${installId}`.execute(
        db,
      ),
      lifetimeKey === null
        ? Promise.resolve({ rows: [] as readonly { marker_key: string }[] })
        : sql<{ marker_key: string }>`select marker_key
          from insights_lifetime_markers
          where marker_key = ${markerKey}`.execute(db),
    ]);
    return {
      revision: String(state.rows[0]?.revision ?? 0),
      state: state.rows[0]?.state ?? null,
      lifetimeExists: marker.rows.length > 0,
    };
  },
  async commitPreparedEvent(prepared) {
    const keys = await prepareInsightsSqlKeys(prepared);
    try {
      const status = await db
        .transaction()
        .execute((transaction) =>
          commit(transaction, provider, prepared, keys),
        );
      return { status };
    } catch (error) {
      if (error instanceof ProjectionConflictError) {
        return { status: "conflict" };
      }
      const code =
        typeof error === "object" && error !== null
          ? String(Reflect.get(error, "code") ?? "")
          : "";
      if (
        [
          "23505",
          "1062",
          "SQLITE_CONSTRAINT_UNIQUE",
          "SQLITE_CONSTRAINT_PRIMARYKEY",
        ].includes(code)
      ) {
        const duplicate = await sql<{ id: string }>`select id from bundle_events
          where id = ${prepared.event.id}`.execute(db);
        return {
          status: duplicate.rows.length > 0 ? "duplicate" : "conflict",
        };
      }
      throw error;
    }
  },
  async getReleaseActivity(input) {
    const keys = await Promise.all(
      input.releases.map((release) =>
        insightsSqlKey(insightsReleaseKey(release)),
      ),
    );
    const summaries = await sql<Record<string, number | string>>`select *
      from insights_release_summaries
      where release_key in (${sql.join(keys)})`.execute(db);
    const hourly =
      input.timeRange === undefined
        ? { rows: [] as readonly Record<string, number | string>[] }
        : await sql<Record<string, number | string>>`select *
          from insights_hourly_activity
          where (${sql.join(
            input.releases.map(
              (release) =>
                sql`(platform = ${release.platform} and channel = ${release.channel} and release_id = ${release.releaseId})`,
            ),
            sql` or `,
          )})
            and hour_start_ms >= ${input.timeRange.start}
            and hour_start_ms < ${input.timeRange.end}
          order by hour_start_ms`.execute(db);
    const summaryByKey = new Map(
      summaries.rows.map((row) => [String(row.release_key), row]),
    );
    const count = (value: number | string | undefined) => {
      const result = Number(value ?? 0);
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new Error("Invalid Insights aggregate");
      }
      return result;
    };
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release, index) => {
        const key = keys[index]!;
        const summary = summaryByKey.get(key);
        const points = rows(hourly).filter(
          (row) =>
            row.platform === release.platform &&
            row.channel === release.channel &&
            row.release_id === release.releaseId,
        );
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
                series: points.map((point) => ({
                  startMs: count(point.hour_start_ms),
                  downloadedReports: count(point.downloaded_reports),
                  appliedReports: count(point.applied_reports),
                  recoveredReports: count(point.recovered_reports),
                })),
              }),
          measuredAtMs: Date.now(),
        };
      }),
    };
  },
});

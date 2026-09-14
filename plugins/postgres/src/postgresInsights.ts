import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  type ReleaseReference,
} from "@hot-updater/plugin-core";
import type {
  InsightsStorageAdapter,
  PreparedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import { type Kysely, sql } from "kysely";

import type { Database } from "./types";

type CountRow = {
  readonly release_key: string;
  readonly active_installations: number | string;
  readonly pending_installations: number | string;
  readonly downloaded_installations: number | string;
  readonly recovered_installations: number | string;
};

class ProjectionConflictError extends Error {}

const count = (value: number | string | undefined): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Postgres returned an invalid Insights aggregate.");
  }
  return result;
};

const insertSummaryDelta = async (
  db: Kysely<Database>,
  release: ReleaseReference,
  delta: {
    readonly active: number;
    readonly pending: number;
    readonly downloaded: number;
    readonly recovered: number;
  },
) => {
  const key = insightsReleaseKey(release);
  await sql`INSERT INTO insights_release_summaries (
    release_key, platform, channel, release_id,
    active_installations, pending_installations,
    downloaded_installations, recovered_installations
  ) VALUES (
    ${key}, ${release.platform}, ${release.channel}, ${release.releaseId},
    0, 0, 0, 0
  ) ON CONFLICT (release_key) DO NOTHING`.execute(db);
  await sql`UPDATE insights_release_summaries SET
    active_installations = active_installations + ${delta.active},
    pending_installations = pending_installations + ${delta.pending},
    downloaded_installations = downloaded_installations + ${delta.downloaded},
    recovered_installations = recovered_installations + ${delta.recovered}
  WHERE release_key = ${key}`.execute(db);
};

const commit = async (
  db: Kysely<Database>,
  prepared: PreparedInsightsEvent,
): Promise<"committed" | "duplicate" | "conflict"> =>
  db.transaction().execute(async (transaction) => {
    const duplicate = await sql<{ id: string }>`SELECT id FROM bundle_events
      WHERE id = ${prepared.event.id}`.execute(transaction);
    if (duplicate.rows.length > 0) return "duplicate";

    const current = await sql<{
      revision: number | string;
    }>`SELECT revision FROM insights_install_states
      WHERE install_id = ${prepared.event.install_id} FOR UPDATE`.execute(
      transaction,
    );
    const actualRevision = Number(current.rows[0]?.revision ?? 0);
    if (String(actualRevision) !== prepared.expectedRevision) return "conflict";
    if (prepared.firstLifetime !== null) {
      const marker = await sql<{ marker_key: string }>`SELECT marker_key
        FROM insights_lifetime_markers
        WHERE marker_key = ${insightsLifetimeMarkerKey(prepared.firstLifetime)}`.execute(
        transaction,
      );
      if (marker.rows.length > 0) return "conflict";
    }

    const event = prepared.event;
    await sql`INSERT INTO bundle_events (
      id, type, install_id, user_id, from_release_id, from_bundle_id,
      to_release_id, to_bundle_id, platform, app_version, channel, metadata,
      received_at_ms
    ) VALUES (
      ${event.id}, ${event.type}, ${event.install_id}, ${event.user_id},
      ${event.from_release_id}, ${event.from_bundle_id}, ${event.to_release_id},
      ${event.to_bundle_id}, ${event.platform}, ${event.app_version},
      ${event.channel}, ${JSON.stringify(event.metadata)}::jsonb,
      ${event.received_at_ms}
    )`.execute(transaction);
    await sql`INSERT INTO bundle_event_heads (
      install_id, id, received_at_ms, user_id, platform, channel, type,
      from_bundle_id, to_bundle_id
    ) VALUES (
      ${event.install_id}, ${event.id}, ${event.received_at_ms}, ${event.user_id},
      ${event.platform}, ${event.channel}, ${event.type}, ${event.from_bundle_id},
      ${event.to_bundle_id}
    ) ON CONFLICT(install_id) DO UPDATE SET
      id = excluded.id, received_at_ms = excluded.received_at_ms,
      user_id = excluded.user_id, platform = excluded.platform,
      channel = excluded.channel, type = excluded.type,
      from_bundle_id = excluded.from_bundle_id,
      to_bundle_id = excluded.to_bundle_id
    WHERE (excluded.received_at_ms, excluded.id) >
      (bundle_event_heads.received_at_ms, bundle_event_heads.id)`.execute(
      transaction,
    );
    if (actualRevision === 0) {
      await sql`INSERT INTO insights_install_states (install_id, revision, state)
        VALUES (${event.install_id}, 1, ${prepared.nextState})`.execute(
        transaction,
      );
    } else {
      const updated = await sql`UPDATE insights_install_states
        SET revision = ${actualRevision + 1}, state = ${prepared.nextState}
        WHERE install_id = ${event.install_id}
          AND revision = ${actualRevision}`.execute(transaction);
      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        throw new ProjectionConflictError();
      }
    }

    const deltas = new Map<
      string,
      {
        release: ReleaseReference;
        active: number;
        pending: number;
        downloaded: number;
        recovered: number;
      }
    >();
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
      const lifetime = prepared.firstLifetime;
      await sql`INSERT INTO insights_lifetime_markers (
        marker_key, release_key, install_id, metric
      ) VALUES (
        ${insightsLifetimeMarkerKey(lifetime)},
        ${insightsReleaseKey(lifetime.release)}, ${lifetime.installId},
        ${lifetime.metric}
      )`.execute(transaction);
      add(lifetime.release, lifetime.metric, 1);
    }
    for (const delta of deltas.values()) {
      await insertSummaryDelta(transaction, delta.release, delta);
    }
    if (prepared.hourly !== null) {
      const hourly = prepared.hourly;
      await sql`INSERT INTO insights_hourly_activity (
        bucket_key, release_key, platform, channel, release_id, hour_start_ms,
        downloaded_reports, applied_reports, recovered_reports
      ) VALUES (
        ${insightsHourlyBucketKey(hourly.release, hourly.hourStartMs)},
        ${insightsReleaseKey(hourly.release)}, ${hourly.release.platform},
        ${hourly.release.channel}, ${hourly.release.releaseId},
        ${hourly.hourStartMs}, ${hourly.metric === "downloaded" ? 1 : 0},
        ${hourly.metric === "applied" ? 1 : 0},
        ${hourly.metric === "recovered" ? 1 : 0}
      ) ON CONFLICT (bucket_key) DO UPDATE SET
        downloaded_reports = insights_hourly_activity.downloaded_reports + excluded.downloaded_reports,
        applied_reports = insights_hourly_activity.applied_reports + excluded.applied_reports,
        recovered_reports = insights_hourly_activity.recovered_reports + excluded.recovered_reports`.execute(
        transaction,
      );
    }
    return "committed";
  });

export const createPostgresInsightsStorage = (
  db: Kysely<Database>,
): InsightsStorageAdapter => ({
  async readRecordContext({ installId, lifetimeKey }) {
    const state = await sql<{
      revision: number | string;
      state: string;
    }>`SELECT revision, state FROM insights_install_states
      WHERE install_id = ${installId}`.execute(db);
    const marker =
      lifetimeKey === null
        ? { rows: [] }
        : await sql<{ marker_key: string }>`SELECT marker_key
            FROM insights_lifetime_markers
            WHERE marker_key = ${insightsLifetimeMarkerKey(lifetimeKey)}`.execute(
            db,
          );
    return {
      revision: String(state.rows[0]?.revision ?? 0),
      state: state.rows[0]?.state ?? null,
      lifetimeExists: marker.rows.length > 0,
    };
  },
  async commitPreparedEvent(prepared) {
    try {
      return { status: await commit(db, prepared) };
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
      if (String(direct ?? nested) === "23505") {
        const duplicate = await sql<{ id: string }>`SELECT id
          FROM bundle_events WHERE id = ${prepared.event.id}`.execute(db);
        return {
          status: duplicate.rows.length > 0 ? "duplicate" : "conflict",
        };
      }
      throw error;
    }
  },
  async getReleaseActivity(input) {
    const keys = input.releases.map(insightsReleaseKey);
    const summaries = await sql<CountRow>`SELECT *
      FROM insights_release_summaries
      WHERE release_key IN (${sql.join(keys)})`.execute(db);
    const summaryByKey = new Map(
      summaries.rows.map((row) => [row.release_key, row]),
    );
    const hourly =
      input.timeRange === undefined
        ? { rows: [] as readonly Record<string, number | string>[] }
        : await sql<Record<string, number | string>>`SELECT *
            FROM insights_hourly_activity
            WHERE release_key IN (${sql.join(keys)})
              AND hour_start_ms >= ${input.timeRange.start}
              AND hour_start_ms < ${input.timeRange.end}
            ORDER BY release_key, hour_start_ms`.execute(db);
    const hourlyByKey = new Map<string, Record<string, number | string>[]>();
    for (const point of hourly.rows) {
      const key = String(point.release_key);
      const values = hourlyByKey.get(key) ?? [];
      values.push(point);
      hourlyByKey.set(key, values);
    }
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release) => {
        const key = insightsReleaseKey(release);
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
                series: (hourlyByKey.get(key) ?? []).map((point) => ({
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

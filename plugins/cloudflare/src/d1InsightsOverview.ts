import type {
  BundleEventRow,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  emptyInsightsDistinct,
  getInsightsDistinctRegister,
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  insightsOverviewValues,
  mergeInsightsDistinct,
  type InsightsOverviewDelta,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor, D1Statement } from "./d1Implementation";
import { encodeD1Values } from "./d1Sql";

type OverviewRow = ReturnType<typeof insightsOverviewValues> & {
  readonly downloads: number;
  readonly launches: number;
  readonly failed_launches: number;
  readonly latest_installations: number;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

const acceptedGuard =
  "EXISTS (SELECT 1 FROM bundle_events WHERE id = json_extract(?, '$') AND insights_processed = 0)";
const newerGuard = `${acceptedGuard} AND NOT EXISTS (
  SELECT 1 FROM bundle_event_heads
  WHERE install_id = json_extract(?, '$')
    AND (received_at_ms, id) >= (json_extract(?, '$'), json_extract(?, '$'))
)`;

const distinctUpdate = (
  field: "launch_users" | "activity_users",
  identity: string | undefined,
): string => {
  if (identity === undefined) return field;
  const position = getInsightsDistinctRegister(identity).index + 1;
  return `CASE WHEN ${field} IS NULL THEN excluded.${field}
    ELSE substr(${field}, 1, ${position - 1}) || char(max(
      unicode(substr(${field}, ${position}, 1)),
      unicode(substr(excluded.${field}, ${position}, 1))
    )) || substr(${field}, ${position + 1}) END`;
};

const deltaStatement = (
  eventId: string,
  delta: InsightsOverviewDelta,
): D1Statement => {
  const values = insightsOverviewValues(delta.identity);
  const row = {
    ...values,
    downloads: delta.downloads,
    launches: delta.launches,
    failed_launches: delta.failedLaunches,
    latest_installations: 0,
    launch_users:
      delta.launchIdentity === undefined
        ? null
        : addInsightsDistinct(emptyInsightsDistinct(), delta.launchIdentity),
    activity_users:
      delta.activityIdentity === undefined
        ? null
        : addInsightsDistinct(emptyInsightsDistinct(), delta.activityIdentity),
  };
  const entries = Object.entries(row);
  return {
    sql: `INSERT INTO insights_overview (${entries.map(([field]) => field).join(", ")})
SELECT ${entries.map(() => "json_extract(?, '$')").join(", ")}
WHERE ${acceptedGuard}
ON CONFLICT(id) DO UPDATE SET
  downloads = downloads + excluded.downloads,
  launches = launches + excluded.launches,
  failed_launches = failed_launches + excluded.failed_launches,
  launch_users = ${distinctUpdate("launch_users", delta.launchIdentity)},
  activity_users = ${distinctUpdate("activity_users", delta.activityIdentity)}`,
    params: encodeD1Values([...entries.map(([, value]) => value), eventId]),
  };
};

const distributionInsert = (
  event: BundleEventRow,
  identity: InsightsOverviewIdentity,
): D1Statement => {
  const row = {
    ...insightsOverviewValues(identity),
    downloads: 0,
    launches: 0,
    failed_launches: 0,
    latest_installations: 1,
    launch_users: null,
    activity_users: null,
  };
  const entries = Object.entries(row);
  return {
    sql: `INSERT INTO insights_overview (${entries.map(([field]) => field).join(", ")})
SELECT ${entries.map(() => "json_extract(?, '$')").join(", ")}
WHERE ${newerGuard}
ON CONFLICT(id) DO UPDATE SET
  latest_installations = latest_installations + 1`,
    params: encodeD1Values([
      ...entries.map(([, value]) => value),
      event.id,
      event.install_id,
      event.received_at_ms,
      event.id,
    ]),
  };
};

const distributionRemove = (event: BundleEventRow): D1Statement => ({
  sql: `UPDATE insights_overview SET latest_installations = latest_installations - 1
WHERE latest_installations > 0
  AND scope_kind = 'distribution'
  AND release_kind = COALESCE((SELECT CASE WHEN current_release_id IS NULL THEN 'embedded' ELSE 'specific' END FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), '')
  AND release_id = COALESCE((SELECT current_release_id FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), '')
  AND channel = COALESCE((SELECT channel FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), '')
  AND platform = COALESCE((SELECT platform FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), '')
  AND app_version_kind = 'specific'
  AND app_version = COALESCE((SELECT app_version FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), '')
  AND period_kind = 'latest'
  AND bucket_start_ms = COALESCE((SELECT CAST(received_at_ms / 3600000 AS INTEGER) * 3600000 FROM bundle_event_heads WHERE install_id = json_extract(?, '$')), -1)
  AND ${newerGuard}`,
  params: encodeD1Values([
    event.install_id,
    event.install_id,
    event.install_id,
    event.install_id,
    event.install_id,
    event.install_id,
    event.id,
    event.install_id,
    event.received_at_ms,
    event.id,
  ]),
});

export const d1InsightsStatements = (
  event: BundleEventRow,
): readonly D1Statement[] => [
  ...insightsOverviewDeltas(event).map((delta) =>
    deltaStatement(event.id, delta),
  ),
  distributionRemove(event),
  distributionInsert(event, insightsDistributionIdentity(event)),
];

const asRow = (value: unknown): OverviewRow => value as OverviewRow;

const releaseIdentity = (
  release: ReleaseReference,
  periodKind: "lifetime" | "hour",
  bucketStartMs: number,
): InsightsOverviewIdentity => ({
  scopeKind: "release",
  releaseKind: "specific",
  releaseId: release.releaseId,
  channel: release.channel,
  platform: release.platform,
  appVersionKind: "all",
  appVersion: "",
  periodKind,
  bucketStartMs,
});

const metrics = (rows: readonly OverviewRow[], withPeriod: boolean) => {
  const daily = new Map<number, { launches: number; failedLaunches: number }>();
  for (const value of rows) {
    const start = Math.floor(value.bucket_start_ms / 86_400_000) * 86_400_000;
    const point = daily.get(start) ?? { launches: 0, failedLaunches: 0 };
    point.launches += value.launches;
    point.failedLaunches += value.failed_launches;
    daily.set(start, point);
  }
  return {
    downloads: rows.reduce((sum, value) => sum + value.downloads, 0),
    launches: rows.reduce((sum, value) => sum + value.launches, 0),
    failedLaunches: rows.reduce((sum, value) => sum + value.failed_launches, 0),
    ...(withPeriod
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map((value) => value.launch_users)),
          ),
          series: [...daily]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getD1ReleaseActivity = async (
  executor: D1Executor,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  let rows: readonly OverviewRow[];
  if (input.scope !== undefined) {
    rows = (
      await executor.query(
        `SELECT * FROM insights_overview WHERE scope_kind = 'channel' AND channel = json_extract(?, '$') AND platform = json_extract(?, '$') AND period_kind = 'hour' AND bucket_start_ms >= json_extract(?, '$') AND bucket_start_ms < json_extract(?, '$') ORDER BY bucket_start_ms`,
        encodeD1Values([
          input.scope.channel,
          input.scope.platform,
          input.timeRange.start,
          input.timeRange.end,
        ]),
      )
    ).map(asRow);
  } else if (input.timeRange === undefined) {
    const ids = input.releases.map((release) =>
      insightsOverviewId(releaseIdentity(release, "lifetime", 0)),
    );
    rows =
      ids.length === 0
        ? []
        : (
            await executor.query(
              "SELECT * FROM insights_overview WHERE id IN (SELECT value FROM json_each(?))",
              encodeD1Values([ids]),
            )
          ).map(asRow);
  } else {
    rows = (
      await executor.query(
        `SELECT * FROM insights_overview WHERE scope_kind = 'release' AND release_id IN (SELECT value FROM json_each(?)) AND period_kind = 'hour' AND bucket_start_ms >= json_extract(?, '$') AND bucket_start_ms < json_extract(?, '$') ORDER BY bucket_start_ms`,
        encodeD1Values([
          input.releases.map(({ releaseId }) => releaseId),
          input.timeRange.start,
          input.timeRange.end,
        ]),
      )
    ).map(asRow);
  }
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    measuredAtMs: Date.now(),
    data:
      input.scope !== undefined
        ? [{ scope: input.scope, metrics: metrics(rows, true) }]
        : input.releases.map((release) => ({
            release,
            metrics: metrics(
              rows.filter(
                (value) =>
                  value.release_id === release.releaseId &&
                  value.channel === release.channel &&
                  value.platform === release.platform,
              ),
              input.timeRange !== undefined,
            ),
          })),
  };
};

export const getD1AppUsage = async (
  executor: D1Executor,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const usage = (
    await executor.query(
      `SELECT * FROM insights_overview WHERE scope_kind = 'usage' AND channel = json_extract(?, '$') AND platform = json_extract(?, '$') AND app_version_kind = json_extract(?, '$') AND app_version = json_extract(?, '$') AND period_kind = 'hour' AND bucket_start_ms >= json_extract(?, '$') AND bucket_start_ms < json_extract(?, '$') ORDER BY bucket_start_ms`,
      encodeD1Values([
        input.channel,
        input.platform,
        input.appVersion === undefined ? "all" : "specific",
        input.appVersion ?? "",
        input.timeRange.start,
        input.timeRange.end,
      ]),
    )
  ).map(asRow);
  const distributionFilters = [
    ...(input.platform === "all" ? [] : ["platform = json_extract(?, '$')"]),
    ...(input.appVersion === undefined
      ? []
      : ["app_version = json_extract(?, '$')"]),
  ];
  const distribution = (
    await executor.query(
      `SELECT * FROM insights_overview WHERE scope_kind = 'distribution' AND channel = json_extract(?, '$') AND period_kind = 'latest'${distributionFilters.length === 0 ? "" : ` AND ${distributionFilters.join(" AND ")}`} AND bucket_start_ms >= json_extract(?, '$') AND bucket_start_ms < json_extract(?, '$') AND latest_installations > 0`,
      encodeD1Values([
        input.channel,
        ...(input.platform === "all" ? [] : [input.platform]),
        ...(input.appVersion === undefined ? [] : [input.appVersion]),
        input.timeRange.start,
        input.timeRange.end,
      ]),
    )
  ).map(asRow);
  const points = [];
  for (
    let startMs = input.timeRange.start;
    startMs < input.timeRange.end;
    startMs += input.intervalMs
  ) {
    points.push({
      startMs,
      installations: countInsightsDistinct(
        mergeInsightsDistinct(
          usage
            .filter(
              (value) =>
                value.bucket_start_ms >= startMs &&
                value.bucket_start_ms < startMs + input.intervalMs,
            )
            .map((value) => value.activity_users),
        ),
      ),
    });
  }
  const group = (field: "app_version" | "platform") => {
    const values = new Map<string, number>();
    for (const value of distribution) {
      values.set(
        value[field],
        (values.get(value[field]) ?? 0) + value.latest_installations,
      );
    }
    return [...values]
      .map(([name, installations]) => ({ name, installations }))
      .sort(
        (left, right) =>
          right.installations - left.installations ||
          left.name.localeCompare(right.name, "en", { numeric: true }),
      );
  };
  const bundle = new Map<
    string,
    InsightsGetAppUsageResult["bundleDistribution"][number]
  >();
  for (const value of distribution) {
    const releaseId =
      value.release_kind === "specific" ? value.release_id : null;
    const key = JSON.stringify([value.app_version, value.platform, releaseId]);
    const previous = bundle.get(key);
    bundle.set(key, {
      appVersion: value.app_version,
      platform: value.platform as "ios" | "android",
      releaseId,
      installations:
        (previous?.installations ?? 0) + value.latest_installations,
    });
  }
  const versions = group("app_version");
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map((value) => value.activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundle.values()],
    measuredAtMs: Date.now(),
  };
};

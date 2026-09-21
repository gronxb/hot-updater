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
import { sql, type QueryExecutorProvider } from "kysely";

import type { ORMSQLProvider } from "../db/types";

type Provider = Exclude<ORMSQLProvider, "mssql">;

type OverviewRow = ReturnType<typeof insightsOverviewValues> & {
  readonly downloads: number | bigint;
  readonly launches: number | bigint;
  readonly failed_launches: number | bigint;
  readonly latest_installations: number | bigint;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

type HeadRow = {
  readonly id: string;
  readonly received_at_ms: number;
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly app_version: string;
  readonly current_release_id: string | null;
};

const number = (value: number | bigint): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Invalid Insights overview counter");
  }
  return result;
};

const isNewer = (event: BundleEventRow, head: HeadRow | undefined): boolean =>
  head === undefined ||
  event.received_at_ms > head.received_at_ms ||
  (event.received_at_ms === head.received_at_ms && event.id > head.id);

const distinctExpression = (
  provider: Provider,
  field: "launch_users" | "activity_users",
  identity: string | undefined,
) => {
  const current = sql.ref(`insights_overview.${field}`);
  if (identity === undefined) return current;
  const position = getInsightsDistinctRegister(identity).index + 1;
  if (provider === "mysql") {
    return sql`case when ${current} is null then values(${sql.ref(field)}) else insert(${current}, ${position}, 1, char(greatest(ascii(substr(${current}, ${position}, 1)), ascii(substr(values(${sql.ref(field)}), ${position}, 1))))) end`;
  }
  if (provider === "sqlite") {
    return sql`case when ${current} is null then excluded.${sql.ref(field)} else substr(${current}, 1, ${position - 1}) || case when substr(${current}, ${position}, 1) >= substr(excluded.${sql.ref(field)}, ${position}, 1) then substr(${current}, ${position}, 1) else substr(excluded.${sql.ref(field)}, ${position}, 1) end || substr(${current}, ${position + 1}) end`;
  }
  return sql`case when ${current} is null then excluded.${sql.ref(field)} else overlay(${current} placing chr(greatest(ascii(substr(${current}, ${position}, 1)), ascii(substr(excluded.${sql.ref(field)}, ${position}, 1)))) from ${position} for 1) end`;
};

const upsertDelta = async (
  executor: QueryExecutorProvider,
  provider: Provider,
  delta: InsightsOverviewDelta,
) => {
  const identity = insightsOverviewValues(delta.identity);
  const row = {
    ...identity,
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
  const insert = sql`insert into insights_overview (${sql.join(entries.map(([field]) => sql.ref(field)))}) values (${sql.join(entries.map(([, value]) => value))})`;
  const assignments = sql.join([
    sql`downloads = insights_overview.downloads + ${delta.downloads}`,
    sql`launches = insights_overview.launches + ${delta.launches}`,
    sql`failed_launches = insights_overview.failed_launches + ${delta.failedLaunches}`,
    sql`launch_users = ${distinctExpression(provider, "launch_users", delta.launchIdentity)}`,
    sql`activity_users = ${distinctExpression(provider, "activity_users", delta.activityIdentity)}`,
  ]);
  await (
    provider === "mysql"
      ? sql`${insert} on duplicate key update ${assignments}`
      : sql`${insert} on conflict (id) do update set ${assignments}`
  ).execute(executor);
};

const distributionIdentity = (head: HeadRow): InsightsOverviewIdentity => ({
  scopeKind: "distribution",
  releaseKind: head.current_release_id === null ? "embedded" : "specific",
  releaseId: head.current_release_id ?? "",
  channel: head.channel,
  platform: head.platform,
  appVersionKind: "specific",
  appVersion: head.app_version,
  periodKind: "latest",
  bucketStartMs: Math.floor(head.received_at_ms / 3_600_000) * 3_600_000,
});

const updateDistribution = async (
  executor: QueryExecutorProvider,
  provider: Provider,
  identity: InsightsOverviewIdentity,
  amount: -1 | 1,
) => {
  const values = insightsOverviewValues(identity);
  if (amount === -1) {
    const result =
      await sql`update insights_overview set latest_installations = latest_installations - 1 where id = ${values.id} and latest_installations > 0`.execute(
        executor,
      );
    if (Number(result.numAffectedRows ?? 0) !== 1) {
      throw new Error("Insights distribution state is inconsistent");
    }
    return;
  }
  const entries = Object.entries({
    ...values,
    downloads: 0,
    launches: 0,
    failed_launches: 0,
    latest_installations: 1,
    launch_users: null,
    activity_users: null,
  });
  const insert = sql`insert into insights_overview (${sql.join(entries.map(([field]) => sql.ref(field)))}) values (${sql.join(entries.map(([, value]) => value))})`;
  await (
    provider === "mysql"
      ? sql`${insert} on duplicate key update latest_installations = latest_installations + 1`
      : sql`${insert} on conflict (id) do update set latest_installations = insights_overview.latest_installations + 1`
  ).execute(executor);
};

export const recordKyselyInsightsOverview = async (
  executor: QueryExecutorProvider,
  provider: Provider,
  event: BundleEventRow,
  previousHead: HeadRow | undefined,
) => {
  for (const delta of insightsOverviewDeltas(event)) {
    await upsertDelta(executor, provider, delta);
  }
  if (!isNewer(event, previousHead)) return;
  if (previousHead !== undefined) {
    await updateDistribution(
      executor,
      provider,
      distributionIdentity(previousHead),
      -1,
    );
  }
  await updateDistribution(
    executor,
    provider,
    insightsDistributionIdentity(event),
    1,
  );
};

export const readKyselyInsightsHead = async (
  executor: QueryExecutorProvider,
  installId: string,
  provider?: Provider,
): Promise<HeadRow | undefined> => {
  const lock =
    provider === undefined || provider === "sqlite" ? sql`` : sql` for update`;
  const result =
    await sql<HeadRow>`select id, received_at_ms, platform, channel, app_version, current_release_id from bundle_event_heads where install_id = ${installId}${lock}`.execute(
      executor,
    );
  return result.rows[0];
};

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

const queryRows = async (
  executor: QueryExecutorProvider,
  input: InsightsGetReleaseActivityInput,
): Promise<readonly OverviewRow[]> => {
  if (input.releases !== undefined && input.timeRange === undefined) {
    const ids = input.releases.map((release) =>
      insightsOverviewId(releaseIdentity(release, "lifetime", 0)),
    );
    if (ids.length === 0) return [];
    return (
      await sql<OverviewRow>`select * from insights_overview where id in (${sql.join(ids)})`.execute(
        executor,
      )
    ).rows;
  }
  const range = input.timeRange!;
  if (input.scope !== undefined) {
    const scope = input.scope;
    return (
      await sql<OverviewRow>`select * from insights_overview where scope_kind = 'channel' and channel = ${scope.channel} and platform = ${scope.platform} and period_kind = 'hour' and bucket_start_ms >= ${range.start} and bucket_start_ms < ${range.end} order by bucket_start_ms`.execute(
        executor,
      )
    ).rows;
  }
  const releaseIds = input.releases!.map(({ releaseId }) => releaseId);
  return (
    await sql<OverviewRow>`select * from insights_overview where scope_kind = 'release' and release_id in (${sql.join(releaseIds)}) and period_kind = 'hour' and bucket_start_ms >= ${range.start} and bucket_start_ms < ${range.end} order by bucket_start_ms`.execute(
      executor,
    )
  ).rows;
};

const metrics = (rows: readonly OverviewRow[], withPeriod: boolean) => {
  const daily = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const start = Math.floor(row.bucket_start_ms / 86_400_000) * 86_400_000;
    const point = daily.get(start) ?? { launches: 0, failedLaunches: 0 };
    point.launches += number(row.launches);
    point.failedLaunches += number(row.failed_launches);
    daily.set(start, point);
  }
  return {
    downloads: rows.reduce((sum, row) => sum + number(row.downloads), 0),
    launches: rows.reduce((sum, row) => sum + number(row.launches), 0),
    failedLaunches: rows.reduce(
      (sum, row) => sum + number(row.failed_launches),
      0,
    ),
    ...(withPeriod
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map((row) => row.launch_users)),
          ),
          series: [...daily]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getKyselyReleaseActivity = async (
  executor: QueryExecutorProvider,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  const rows = await queryRows(executor, input);
  const withPeriod = input.timeRange !== undefined;
  const data =
    input.scope !== undefined
      ? [{ scope: input.scope, metrics: metrics(rows, true) }]
      : input.releases!.map((release) => ({
          release,
          metrics: metrics(
            rows.filter(
              (row) =>
                row.release_id === release.releaseId &&
                row.platform === release.platform &&
                row.channel === release.channel,
            ),
            withPeriod,
          ),
        }));
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data,
    measuredAtMs: Date.now(),
  };
};

export const getKyselyAppUsage = async (
  executor: QueryExecutorProvider,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const appVersionKind = input.appVersion === undefined ? "all" : "specific";
  const appVersion = input.appVersion ?? "";
  const usage = (
    await sql<OverviewRow>`select * from insights_overview where scope_kind = 'usage' and channel = ${input.channel} and platform = ${input.platform} and app_version_kind = ${appVersionKind} and app_version = ${appVersion} and period_kind = 'hour' and bucket_start_ms >= ${input.timeRange.start} and bucket_start_ms < ${input.timeRange.end} order by bucket_start_ms`.execute(
      executor,
    )
  ).rows;
  const distribution = (
    await sql<OverviewRow>`select * from insights_overview where scope_kind = 'distribution' and channel = ${input.channel} and period_kind = 'latest' and bucket_start_ms >= ${input.timeRange.start} and bucket_start_ms < ${input.timeRange.end}${input.platform === "all" ? sql`` : sql` and platform = ${input.platform}`}${input.appVersion === undefined ? sql`` : sql` and app_version = ${input.appVersion}`}`.execute(
      executor,
    )
  ).rows.filter((row) => number(row.latest_installations) > 0);
  const pointStarts: number[] = [];
  for (
    let start = input.timeRange.start;
    start < input.timeRange.end;
    start += input.intervalMs
  ) {
    pointStarts.push(start);
  }
  const points = pointStarts.map((startMs) => ({
    startMs,
    installations: countInsightsDistinct(
      mergeInsightsDistinct(
        usage
          .filter(
            (row) =>
              row.bucket_start_ms >= startMs &&
              row.bucket_start_ms < startMs + input.intervalMs,
          )
          .map((row) => row.activity_users),
      ),
    ),
  }));
  const group = (field: "app_version" | "platform") => {
    const values = new Map<string, number>();
    for (const row of distribution) {
      values.set(
        row[field],
        (values.get(row[field]) ?? 0) + number(row.latest_installations),
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
  for (const row of distribution) {
    const releaseId = row.release_kind === "specific" ? row.release_id : null;
    const key = JSON.stringify([row.app_version, row.platform, releaseId]);
    const previous = bundle.get(key);
    bundle.set(key, {
      appVersion: row.app_version,
      platform: row.platform as "ios" | "android",
      releaseId,
      installations:
        (previous?.installations ?? 0) + number(row.latest_installations),
    });
  }
  const versions = group("app_version");
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map((row) => row.activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundle.values()],
    measuredAtMs: Date.now(),
  };
};

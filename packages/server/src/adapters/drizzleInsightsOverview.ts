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
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import type { DrizzleProvider } from "./drizzle";
import type { DrizzleDB, DrizzleTable } from "./drizzleLazyDB";

const table = (db: DrizzleDB, name: string): DrizzleTable => {
  const value = db._.fullSchema[name];
  if (value === undefined) throw new Error(`Drizzle schema is missing ${name}`);
  return value;
};

const column = (value: DrizzleTable, name: string): SQLWrapper => {
  const result = value[name];
  if (
    typeof result !== "object" ||
    result === null ||
    !("getSQL" in result) ||
    typeof result.getSQL !== "function"
  ) {
    throw new Error(`Drizzle schema is missing ${name}`);
  }
  return result as SQLWrapper;
};

export type DrizzleOverviewRow = ReturnType<typeof insightsOverviewValues> & {
  readonly downloads: number | bigint;
  readonly launches: number | bigint;
  readonly failed_launches: number | bigint;
  readonly latest_installations: number | bigint;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

export type DrizzleHeadRow = {
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

const distinctExpression = (
  provider: DrizzleProvider,
  field: "launch_users" | "activity_users",
  identity: string | undefined,
) => {
  const current = sql`insights_overview.${sql.identifier(field)}`;
  if (identity === undefined) return current;
  const position = getInsightsDistinctRegister(identity).index + 1;
  if (provider === "mysql") {
    return sql`case when ${current} is null then values(${sql.identifier(field)}) else insert(${current}, ${position}, 1, char(greatest(ascii(substr(${current}, ${position}, 1)), ascii(substr(values(${sql.identifier(field)}), ${position}, 1))))) end`;
  }
  if (provider === "sqlite") {
    return sql`case when ${current} is null then excluded.${sql.identifier(field)} else substr(${current}, 1, ${position - 1}) || case when substr(${current}, ${position}, 1) >= substr(excluded.${sql.identifier(field)}, ${position}, 1) then substr(${current}, ${position}, 1) else substr(excluded.${sql.identifier(field)}, ${position}, 1) end || substr(${current}, ${position + 1}) end`;
  }
  return sql`case when ${current} is null then excluded.${sql.identifier(field)} else overlay(${current} placing chr(greatest(ascii(substr(${current}, ${position}, 1)), ascii(substr(excluded.${sql.identifier(field)}, ${position}, 1)))) from ${position} for 1) end`;
};

const execute = async (db: DrizzleDB, query: ReturnType<typeof sql>) => {
  if (db.execute !== undefined) return db.execute(query);
  if (db.run !== undefined) return db.run(query);
  throw new Error("Drizzle Insights requires SQL execution support");
};

const upsertDeltaQuery = (
  provider: DrizzleProvider,
  delta: InsightsOverviewDelta,
) => {
  const values = {
    ...insightsOverviewValues(delta.identity),
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
  const entries = Object.entries(values);
  const insert = sql`insert into insights_overview (${sql.join(
    entries.map(([field]) => sql.identifier(field)),
    sql`, `,
  )}) values (${sql.join(
    entries.map(([, value]) => sql`${value}`),
    sql`, `,
  )})`;
  const assignments = sql.join(
    [
      sql`downloads = insights_overview.downloads + ${delta.downloads}`,
      sql`launches = insights_overview.launches + ${delta.launches}`,
      sql`failed_launches = insights_overview.failed_launches + ${delta.failedLaunches}`,
      sql`launch_users = ${distinctExpression(provider, "launch_users", delta.launchIdentity)}`,
      sql`activity_users = ${distinctExpression(provider, "activity_users", delta.activityIdentity)}`,
    ],
    sql`, `,
  );
  return provider === "mysql"
    ? sql`${insert} on duplicate key update ${assignments}`
    : sql`${insert} on conflict (id) do update set ${assignments}`;
};

const headDistribution = (head: DrizzleHeadRow): InsightsOverviewIdentity => ({
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

const distributionQuery = (
  provider: DrizzleProvider,
  identity: InsightsOverviewIdentity,
  amount: -1 | 1,
) => {
  const values = insightsOverviewValues(identity);
  if (amount === -1) {
    return sql`update insights_overview set latest_installations = latest_installations - 1 where id = ${values.id} and latest_installations > 0`;
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
  const insert = sql`insert into insights_overview (${sql.join(
    entries.map(([field]) => sql.identifier(field)),
    sql`, `,
  )}) values (${sql.join(
    entries.map(([, value]) => sql`${value}`),
    sql`, `,
  )})`;
  return provider === "mysql"
    ? sql`${insert} on duplicate key update latest_installations = latest_installations + 1`
    : sql`${insert} on conflict (id) do update set latest_installations = insights_overview.latest_installations + 1`;
};

const isNewer = (
  event: BundleEventRow,
  previousHead: DrizzleHeadRow | undefined,
): boolean =>
  previousHead === undefined ||
  event.received_at_ms > previousHead.received_at_ms ||
  (event.received_at_ms === previousHead.received_at_ms &&
    event.id > previousHead.id);

export const recordDrizzleInsightsOverview = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  event: BundleEventRow,
  previousHead: DrizzleHeadRow | undefined,
): Promise<void> => {
  for (const delta of insightsOverviewDeltas(event)) {
    await execute(db, upsertDeltaQuery(provider, delta));
  }
  if (!isNewer(event, previousHead)) return;
  if (previousHead !== undefined) {
    await execute(
      db,
      distributionQuery(provider, headDistribution(previousHead), -1),
    );
  }
  await execute(
    db,
    distributionQuery(provider, insightsDistributionIdentity(event), 1),
  );
};

export const recordDrizzleInsightsOverviewSync = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  event: BundleEventRow,
  previousHead: DrizzleHeadRow | undefined,
): void => {
  if (db.run === undefined) {
    throw new Error("Synchronous Drizzle Insights requires run support");
  }
  for (const delta of insightsOverviewDeltas(event)) {
    db.run(upsertDeltaQuery(provider, delta));
  }
  if (!isNewer(event, previousHead)) return;
  if (previousHead !== undefined) {
    db.run(distributionQuery(provider, headDistribution(previousHead), -1));
  }
  db.run(distributionQuery(provider, insightsDistributionIdentity(event), 1));
};

const releaseIdentity = (
  release: ReleaseReference,
): InsightsOverviewIdentity => ({
  scopeKind: "release",
  releaseKind: "specific",
  releaseId: release.releaseId,
  channel: release.channel,
  platform: release.platform,
  appVersionKind: "all",
  appVersion: "",
  periodKind: "lifetime",
  bucketStartMs: 0,
});

const metrics = (rows: readonly DrizzleOverviewRow[], ranged: boolean) => {
  const days = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const startMs = Math.floor(row.bucket_start_ms / 86_400_000) * 86_400_000;
    const point = days.get(startMs) ?? { launches: 0, failedLaunches: 0 };
    point.launches += number(row.launches);
    point.failedLaunches += number(row.failed_launches);
    days.set(startMs, point);
  }
  return {
    downloads: rows.reduce((sum, row) => sum + number(row.downloads), 0),
    launches: rows.reduce((sum, row) => sum + number(row.launches), 0),
    failedLaunches: rows.reduce(
      (sum, row) => sum + number(row.failed_launches),
      0,
    ),
    ...(ranged
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map(({ launch_users }) => launch_users)),
          ),
          series: [...days]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getDrizzleReleaseActivity = async (
  db: DrizzleDB,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  const overview = table(db, "insights_overview");
  let where;
  if (input.scope !== undefined) {
    where = and(
      eq(column(overview, "scope_kind"), "channel"),
      eq(column(overview, "channel"), input.scope.channel),
      eq(column(overview, "platform"), input.scope.platform),
      eq(column(overview, "period_kind"), "hour"),
      gte(column(overview, "bucket_start_ms"), input.timeRange.start),
      lt(column(overview, "bucket_start_ms"), input.timeRange.end),
    );
  } else if (input.timeRange === undefined) {
    where = inArray(
      column(overview, "id"),
      input.releases.map((release) =>
        insightsOverviewId(releaseIdentity(release)),
      ),
    );
  } else {
    where = and(
      eq(column(overview, "scope_kind"), "release"),
      inArray(
        column(overview, "release_id"),
        input.releases.map(({ releaseId }) => releaseId),
      ),
      eq(column(overview, "period_kind"), "hour"),
      gte(column(overview, "bucket_start_ms"), input.timeRange.start),
      lt(column(overview, "bucket_start_ms"), input.timeRange.end),
    );
  }
  const rows = await db.query.insights_overview.findMany({
    where,
    orderBy: asc(column(overview, "bucket_start_ms")),
  });
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data:
      input.scope !== undefined
        ? [{ scope: input.scope, metrics: metrics(rows, true) }]
        : input.releases.map((release) => ({
            release,
            metrics: metrics(
              rows.filter(
                (row) =>
                  row.release_id === release.releaseId &&
                  row.channel === release.channel &&
                  row.platform === release.platform,
              ),
              input.timeRange !== undefined,
            ),
          })),
    measuredAtMs: Date.now(),
  };
};

export const getDrizzleAppUsage = async (
  db: DrizzleDB,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const overview = table(db, "insights_overview");
  const field = (name: string) => column(overview, name);
  const usage = await db.query.insights_overview.findMany({
    where: and(
      eq(field("scope_kind"), "usage"),
      eq(field("channel"), input.channel),
      eq(field("platform"), input.platform),
      eq(
        field("app_version_kind"),
        input.appVersion === undefined ? "all" : "specific",
      ),
      eq(field("app_version"), input.appVersion ?? ""),
      eq(field("period_kind"), "hour"),
      gte(field("bucket_start_ms"), input.timeRange.start),
      lt(field("bucket_start_ms"), input.timeRange.end),
    ),
    orderBy: asc(field("bucket_start_ms")),
  });
  const distribution = await db.query.insights_overview.findMany({
    where: and(
      eq(field("scope_kind"), "distribution"),
      eq(field("channel"), input.channel),
      eq(field("period_kind"), "latest"),
      input.platform === "all"
        ? undefined
        : eq(field("platform"), input.platform),
      input.appVersion === undefined
        ? undefined
        : eq(field("app_version"), input.appVersion),
      gte(field("bucket_start_ms"), input.timeRange.start),
      lt(field("bucket_start_ms"), input.timeRange.end),
    ),
  });
  const visibleDistribution = distribution.filter(
    ({ latest_installations }) => number(latest_installations) > 0,
  );
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
              (row) =>
                row.bucket_start_ms >= startMs &&
                row.bucket_start_ms < startMs + input.intervalMs,
            )
            .map(({ activity_users }) => activity_users),
        ),
      ),
    });
  }
  const group = (field: "app_version" | "platform") => {
    const values = new Map<string, number>();
    for (const row of visibleDistribution) {
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
          left.name.localeCompare(right.name),
      );
  };
  const bundles = new Map<
    string,
    InsightsGetAppUsageResult["bundleDistribution"][number]
  >();
  for (const row of visibleDistribution) {
    const releaseId = row.release_kind === "specific" ? row.release_id : null;
    const key = JSON.stringify([row.app_version, row.platform, releaseId]);
    const previous = bundles.get(key);
    bundles.set(key, {
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
      mergeInsightsDistinct(usage.map(({ activity_users }) => activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundles.values()],
    measuredAtMs: Date.now(),
  };
};

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
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  insightsOverviewValues,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

import { PrismaAdapterError } from "./prismaRows";

type Delegate = {
  findFirst(args: object): Promise<OverviewRow | HeadRow | null>;
  findMany(args: object): Promise<readonly OverviewRow[]>;
  create(args: object): Promise<unknown>;
  update(args: object): Promise<unknown>;
  upsert(args: object): Promise<unknown>;
};

type OverviewRow = ReturnType<typeof insightsOverviewValues> & {
  readonly downloads: number | bigint;
  readonly launches: number | bigint;
  readonly failed_launches: number | bigint;
  readonly latest_installations: number | bigint;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

const number = (value: number | bigint): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new PrismaAdapterError("invalid Insights overview counter");
  }
  return result;
};

type HeadRow = {
  readonly id: string;
  readonly received_at_ms: number;
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly app_version: string;
  readonly current_release_id: string | null;
};

const delegate = (client: object, name: string): Delegate => {
  const value = Reflect.get(client, name);
  if (
    typeof value !== "object" ||
    value === null ||
    !["findFirst", "findMany", "create", "update", "upsert"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  ) {
    throw new PrismaAdapterError(`missing model delegate "${name}"`);
  }
  return value as Delegate;
};

export const readPrismaInsightsHead = async (
  client: object,
  installId: string,
): Promise<HeadRow | undefined> => {
  const row = await delegate(client, "bundle_event_heads").findFirst({
    where: { install_id: installId },
  });
  return (row ?? undefined) as HeadRow | undefined;
};

const newer = (event: BundleEventRow, head: HeadRow | undefined): boolean =>
  head === undefined ||
  event.received_at_ms > head.received_at_ms ||
  (event.received_at_ms === head.received_at_ms && event.id > head.id);

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

const emptyRow = (identity: InsightsOverviewIdentity): OverviewRow => ({
  ...insightsOverviewValues(identity),
  downloads: 0,
  launches: 0,
  failed_launches: 0,
  latest_installations: 0,
  launch_users: null,
  activity_users: null,
});

export const recordPrismaInsightsOverview = async (
  client: object,
  event: BundleEventRow,
  previousHead: HeadRow | undefined,
) => {
  const overview = delegate(client, "insights_overview");
  for (const delta of insightsOverviewDeltas(event)) {
    const id = insightsOverviewId(delta.identity);
    const current = (await overview.findFirst({
      where: { id },
    })) as OverviewRow | null;
    const next = {
      ...(current ?? emptyRow(delta.identity)),
      downloads: number(current?.downloads ?? 0) + delta.downloads,
      launches: number(current?.launches ?? 0) + delta.launches,
      failed_launches:
        number(current?.failed_launches ?? 0) + delta.failedLaunches,
      launch_users:
        delta.launchIdentity === undefined
          ? (current?.launch_users ?? null)
          : addInsightsDistinct(current?.launch_users, delta.launchIdentity),
      activity_users:
        delta.activityIdentity === undefined
          ? (current?.activity_users ?? null)
          : addInsightsDistinct(
              current?.activity_users,
              delta.activityIdentity,
            ),
    };
    await overview.upsert({ where: { id }, create: next, update: next });
  }
  if (!newer(event, previousHead)) return;
  if (previousHead !== undefined) {
    const identity = distributionIdentity(previousHead);
    const id = insightsOverviewId(identity);
    const current = (await overview.findFirst({
      where: { id },
    })) as OverviewRow | null;
    if (current === null || number(current.latest_installations) < 1) {
      throw new PrismaAdapterError("inconsistent Insights distribution");
    }
    await overview.update({
      where: { id },
      data: {
        latest_installations: number(current.latest_installations) - 1,
      },
    });
  }
  const identity = insightsDistributionIdentity(event);
  const id = insightsOverviewId(identity);
  const current = (await overview.findFirst({
    where: { id },
  })) as OverviewRow | null;
  const row = {
    ...(current ?? emptyRow(identity)),
    latest_installations: number(current?.latest_installations ?? 0) + 1,
  };
  await overview.upsert({ where: { id }, create: row, update: row });
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

const releaseRows = async (
  client: object,
  input: InsightsGetReleaseActivityInput,
): Promise<readonly OverviewRow[]> => {
  const overview = delegate(client, "insights_overview");
  if (input.releases !== undefined && input.timeRange === undefined) {
    return overview.findMany({
      where: {
        id: {
          in: input.releases.map((item) =>
            insightsOverviewId(releaseIdentity(item)),
          ),
        },
      },
    });
  }
  const range = input.timeRange!;
  if (input.scope !== undefined) {
    return overview.findMany({
      where: {
        scope_kind: "channel",
        channel: input.scope.channel,
        platform: input.scope.platform,
        period_kind: "hour",
        bucket_start_ms: { gte: range.start, lt: range.end },
      },
      orderBy: { bucket_start_ms: "asc" },
    });
  }
  return overview.findMany({
    where: {
      scope_kind: "release",
      release_id: { in: input.releases!.map(({ releaseId }) => releaseId) },
      period_kind: "hour",
      bucket_start_ms: { gte: range.start, lt: range.end },
    },
    orderBy: { bucket_start_ms: "asc" },
  });
};

const metrics = (rows: readonly OverviewRow[], ranged: boolean) => {
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

export const getPrismaReleaseActivity = async (
  client: object,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  const rows = await releaseRows(client, input);
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data:
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
              input.timeRange !== undefined,
            ),
          })),
    measuredAtMs: Date.now(),
  };
};

export const getPrismaAppUsage = async (
  client: object,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const overview = delegate(client, "insights_overview");
  const usage = await overview.findMany({
    where: {
      scope_kind: "usage",
      channel: input.channel,
      platform: input.platform,
      app_version_kind: input.appVersion === undefined ? "all" : "specific",
      app_version: input.appVersion ?? "",
      period_kind: "hour",
      bucket_start_ms: { gte: input.timeRange.start, lt: input.timeRange.end },
    },
    orderBy: { bucket_start_ms: "asc" },
  });
  const distribution = (
    await overview.findMany({
      where: {
        scope_kind: "distribution",
        channel: input.channel,
        period_kind: "latest",
        ...(input.platform === "all" ? {} : { platform: input.platform }),
        ...(input.appVersion === undefined
          ? {}
          : { app_version: input.appVersion }),
        bucket_start_ms: {
          gte: input.timeRange.start,
          lt: input.timeRange.end,
        },
      },
    })
  ).filter((row) => number(row.latest_installations) > 0);
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
    for (const row of distribution)
      values.set(
        row[field],
        (values.get(row[field]) ?? 0) + number(row.latest_installations),
      );
    return [...values]
      .map(([name, installations]) => ({ name, installations }))
      .sort(
        (a, b) =>
          b.installations - a.installations || a.name.localeCompare(b.name),
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
      mergeInsightsDistinct(usage.map(({ activity_users }) => activity_users)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution: [...bundle.values()],
    measuredAtMs: Date.now(),
  };
};

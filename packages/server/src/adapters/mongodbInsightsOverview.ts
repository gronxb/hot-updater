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
import type { ClientSession, Filter } from "mongodb";

import type {
  MongoBundleEventHead,
  MongoCollections,
  MongoInsightsOverview,
} from "./mongodbCollections";
import { WITHOUT_MONGO_ID } from "./mongodbCollections";

const emptyRow = (
  identity: InsightsOverviewIdentity,
): MongoInsightsOverview => ({
  ...insightsOverviewValues(identity),
  downloads: 0,
  launches: 0,
  failed_launches: 0,
  latest_installations: 0,
  launch_users: null,
  activity_users: null,
});

const newer = (
  event: BundleEventRow,
  head: MongoBundleEventHead | null,
): boolean =>
  head === null ||
  event.received_at_ms > head.received_at_ms ||
  (event.received_at_ms === head.received_at_ms && event.id > head.id);

const headDistribution = (
  head: MongoBundleEventHead,
): InsightsOverviewIdentity => ({
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

const save = async (
  collections: MongoCollections,
  session: ClientSession,
  row: MongoInsightsOverview,
): Promise<void> => {
  await collections.insightsOverview.replaceOne({ id: row.id }, row, {
    session,
    upsert: true,
    collation: { locale: "simple" },
  });
};

export const recordMongoInsightsOverview = async (
  collections: MongoCollections,
  session: ClientSession,
  event: BundleEventRow,
  previousHead: MongoBundleEventHead | null,
): Promise<void> => {
  for (const delta of insightsOverviewDeltas(event)) {
    const id = insightsOverviewId(delta.identity);
    const current = await collections.insightsOverview.findOne(
      { id },
      {
        session,
        projection: WITHOUT_MONGO_ID,
        collation: { locale: "simple" },
      },
    );
    await save(collections, session, {
      ...(current ?? emptyRow(delta.identity)),
      downloads: (current?.downloads ?? 0) + delta.downloads,
      launches: (current?.launches ?? 0) + delta.launches,
      failed_launches: (current?.failed_launches ?? 0) + delta.failedLaunches,
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
    });
  }
  if (!newer(event, previousHead)) return;
  if (previousHead !== null) {
    const identity = headDistribution(previousHead);
    const id = insightsOverviewId(identity);
    const current = await collections.insightsOverview.findOne(
      { id },
      {
        session,
        projection: WITHOUT_MONGO_ID,
        collation: { locale: "simple" },
      },
    );
    if (current === null || current.latest_installations < 1) {
      throw new Error("inconsistent Insights distribution");
    }
    await save(collections, session, {
      ...current,
      latest_installations: current.latest_installations - 1,
    });
  }
  const identity = insightsDistributionIdentity(event);
  const id = insightsOverviewId(identity);
  const current = await collections.insightsOverview.findOne(
    { id },
    { session, projection: WITHOUT_MONGO_ID, collation: { locale: "simple" } },
  );
  await save(collections, session, {
    ...(current ?? emptyRow(identity)),
    latest_installations: (current?.latest_installations ?? 0) + 1,
  });
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

const metrics = (rows: readonly MongoInsightsOverview[], ranged: boolean) => {
  const days = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const startMs = Math.floor(row.bucket_start_ms / 86_400_000) * 86_400_000;
    const point = days.get(startMs) ?? { launches: 0, failedLaunches: 0 };
    point.launches += row.launches;
    point.failedLaunches += row.failed_launches;
    days.set(startMs, point);
  }
  return {
    downloads: rows.reduce((sum, row) => sum + row.downloads, 0),
    launches: rows.reduce((sum, row) => sum + row.launches, 0),
    failedLaunches: rows.reduce((sum, row) => sum + row.failed_launches, 0),
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

export const getMongoReleaseActivity = async (
  collections: MongoCollections,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  let filter: Filter<MongoInsightsOverview>;
  if (input.scope !== undefined) {
    filter = {
      scope_kind: "channel",
      channel: input.scope.channel,
      platform: input.scope.platform,
      period_kind: "hour",
      bucket_start_ms: {
        $gte: input.timeRange.start,
        $lt: input.timeRange.end,
      },
    };
  } else if (input.timeRange === undefined) {
    filter = {
      id: {
        $in: input.releases.map((release) =>
          insightsOverviewId(releaseIdentity(release)),
        ),
      },
    };
  } else {
    filter = {
      scope_kind: "release",
      release_id: { $in: input.releases.map(({ releaseId }) => releaseId) },
      period_kind: "hour",
      bucket_start_ms: {
        $gte: input.timeRange.start,
        $lt: input.timeRange.end,
      },
    };
  }
  const rows = await collections.insightsOverview
    .find(filter, {
      projection: WITHOUT_MONGO_ID,
      collation: { locale: "simple" },
      readPreference: "primary",
    })
    .sort({ bucket_start_ms: 1 })
    .toArray();
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

export const getMongoAppUsage = async (
  collections: MongoCollections,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const usage = await collections.insightsOverview
    .find(
      {
        scope_kind: "usage",
        channel: input.channel,
        platform: input.platform,
        app_version_kind: input.appVersion === undefined ? "all" : "specific",
        app_version: input.appVersion ?? "",
        period_kind: "hour",
        bucket_start_ms: {
          $gte: input.timeRange.start,
          $lt: input.timeRange.end,
        },
      },
      { projection: WITHOUT_MONGO_ID, readPreference: "primary" },
    )
    .sort({ bucket_start_ms: 1 })
    .toArray();
  const distribution = await collections.insightsOverview
    .find(
      {
        scope_kind: "distribution",
        channel: input.channel,
        period_kind: "latest",
        ...(input.platform === "all" ? {} : { platform: input.platform }),
        ...(input.appVersion === undefined
          ? {}
          : { app_version: input.appVersion }),
        bucket_start_ms: {
          $gte: input.timeRange.start,
          $lt: input.timeRange.end,
        },
        latest_installations: { $gt: 0 },
      },
      { projection: WITHOUT_MONGO_ID, readPreference: "primary" },
    )
    .toArray();
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
    for (const row of distribution) {
      values.set(
        row[field],
        (values.get(row[field]) ?? 0) + row.latest_installations,
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
  for (const row of distribution) {
    const releaseId = row.release_kind === "specific" ? row.release_id : null;
    const key = JSON.stringify([row.app_version, row.platform, releaseId]);
    const previous = bundles.get(key);
    bundles.set(key, {
      appVersion: row.app_version,
      platform: row.platform as "ios" | "android",
      releaseId,
      installations: (previous?.installations ?? 0) + row.latest_installations,
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

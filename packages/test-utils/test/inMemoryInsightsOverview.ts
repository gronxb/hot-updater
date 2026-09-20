import type {
  BundleEventRow,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
} from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";

type Row = {
  readonly identity: InsightsOverviewIdentity;
  downloads: number;
  launches: number;
  failedLaunches: number;
  latestInstallations: number;
  launchUsers: string | null;
  activityUsers: string | null;
};

const rowsFor = (events: readonly BundleEventRow[]): readonly Row[] => {
  const rows = new Map<string, Row>();
  const get = (identity: InsightsOverviewIdentity) => {
    const id = insightsOverviewId(identity);
    let value = rows.get(id);
    if (value === undefined) {
      value = {
        identity,
        downloads: 0,
        launches: 0,
        failedLaunches: 0,
        latestInstallations: 0,
        launchUsers: null,
        activityUsers: null,
      };
      rows.set(id, value);
    }
    return value;
  };
  for (const event of events) {
    for (const delta of insightsOverviewDeltas(event)) {
      const value = get(delta.identity);
      value.downloads += delta.downloads;
      value.launches += delta.launches;
      value.failedLaunches += delta.failedLaunches;
      if (delta.launchIdentity !== undefined) {
        value.launchUsers = addInsightsDistinct(
          value.launchUsers,
          delta.launchIdentity,
        );
      }
      if (delta.activityIdentity !== undefined) {
        value.activityUsers = addInsightsDistinct(
          value.activityUsers,
          delta.activityIdentity,
        );
      }
    }
  }
  const latest = new Map<string, BundleEventRow>();
  for (const event of events) {
    const current = latest.get(event.install_id);
    if (
      current === undefined ||
      event.received_at_ms > current.received_at_ms ||
      (event.received_at_ms === current.received_at_ms && event.id > current.id)
    ) {
      latest.set(event.install_id, event);
    }
  }
  for (const event of latest.values()) {
    get(insightsDistributionIdentity(event)).latestInstallations += 1;
  }
  return [...rows.values()];
};

const metrics = (rows: readonly Row[], ranged: boolean) => {
  const days = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const startMs =
      Math.floor(row.identity.bucketStartMs / 86_400_000) * 86_400_000;
    const point = days.get(startMs) ?? { launches: 0, failedLaunches: 0 };
    point.launches += row.launches;
    point.failedLaunches += row.failedLaunches;
    days.set(startMs, point);
  }
  return {
    downloads: rows.reduce((sum, row) => sum + row.downloads, 0),
    launches: rows.reduce((sum, row) => sum + row.launches, 0),
    failedLaunches: rows.reduce((sum, row) => sum + row.failedLaunches, 0),
    ...(ranged
      ? {
          uniqueUsers: countInsightsDistinct(
            mergeInsightsDistinct(rows.map(({ launchUsers }) => launchUsers)),
          ),
          series: [...days]
            .sort(([left], [right]) => left - right)
            .map(([startMs, point]) => ({ startMs, ...point })),
        }
      : {}),
  };
};

export const getInMemoryReleaseActivity = (
  events: readonly BundleEventRow[],
  input: InsightsGetReleaseActivityInput,
): InsightsGetReleaseActivityResult => {
  const all = rowsFor(events);
  const ranged = input.timeRange !== undefined;
  const rows = all.filter(({ identity }) => {
    if (input.scope !== undefined) {
      return (
        identity.scopeKind === "channel" &&
        identity.channel === input.scope.channel &&
        identity.platform === input.scope.platform &&
        identity.periodKind === "hour" &&
        identity.bucketStartMs >= input.timeRange.start &&
        identity.bucketStartMs < input.timeRange.end
      );
    }
    return input.releases.some(
      (release) =>
        identity.scopeKind === "release" &&
        identity.releaseId === release.releaseId &&
        identity.channel === release.channel &&
        identity.platform === release.platform &&
        (ranged
          ? identity.periodKind === "hour" &&
            identity.bucketStartMs >= input.timeRange!.start &&
            identity.bucketStartMs < input.timeRange!.end
          : identity.periodKind === "lifetime"),
    );
  });
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
                ({ identity }) =>
                  identity.releaseId === release.releaseId &&
                  identity.channel === release.channel &&
                  identity.platform === release.platform,
              ),
              ranged,
            ),
          })),
  };
};

export const getInMemoryAppUsage = (
  events: readonly BundleEventRow[],
  input: InsightsGetAppUsageInput,
): InsightsGetAppUsageResult => {
  const all = rowsFor(events);
  const usage = all.filter(
    ({ identity }) =>
      identity.scopeKind === "usage" &&
      identity.channel === input.channel &&
      identity.platform === input.platform &&
      identity.appVersionKind ===
        (input.appVersion === undefined ? "all" : "specific") &&
      identity.appVersion === (input.appVersion ?? "") &&
      identity.bucketStartMs >= input.timeRange.start &&
      identity.bucketStartMs < input.timeRange.end,
  );
  const distribution = all.filter(
    ({ identity, latestInstallations }) =>
      identity.scopeKind === "distribution" &&
      identity.channel === input.channel &&
      identity.bucketStartMs >= input.timeRange.start &&
      identity.bucketStartMs < input.timeRange.end &&
      latestInstallations > 0 &&
      (input.platform === "all" || identity.platform === input.platform) &&
      (input.appVersion === undefined ||
        identity.appVersion === input.appVersion),
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
              ({ identity }) =>
                identity.bucketStartMs >= startMs &&
                identity.bucketStartMs < startMs + input.intervalMs,
            )
            .map(({ activityUsers }) => activityUsers),
        ),
      ),
    });
  }
  const group = (field: "appVersion" | "platform") => {
    const values = new Map<string, number>();
    for (const row of distribution) {
      const name =
        field === "appVersion"
          ? row.identity.appVersion
          : row.identity.platform;
      values.set(name, (values.get(name) ?? 0) + row.latestInstallations);
    }
    return [...values]
      .map(([name, installations]) => ({ name, installations }))
      .sort(
        (left, right) =>
          right.installations - left.installations ||
          left.name.localeCompare(right.name, "en", { numeric: true }),
      );
  };
  const bundleDistribution = distribution.map((row) => ({
    appVersion: row.identity.appVersion,
    platform: row.identity.platform as "ios" | "android",
    releaseId:
      row.identity.releaseKind === "specific" ? row.identity.releaseId : null,
    installations: row.latestInstallations,
  }));
  const versions = group("appVersion");
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map(({ activityUsers }) => activityUsers)),
    ),
    points,
    appVersions: versions.map(({ name }) => name),
    versions,
    platforms: group("platform"),
    bundleDistribution,
    measuredAtMs: Date.now(),
  };
};

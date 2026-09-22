import {
  compareInsightsText,
  type BundleEventRow,
  type InsightsGetAppUsageInput,
  type InsightsGetAppUsageResult,
  type InsightsGetReleaseActivityInput,
  type InsightsGetReleaseActivityResult,
  type ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
  addInsightsDistinct,
  countInsightsDistinct,
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

import { matchesMockDatabaseWhere } from "./mockDatabaseQuery";
import {
  cloneMockDatabaseData,
  createMockDatabaseData,
  createMockDatabaseState,
  type MockBundleEventHead,
  type MockInsightsOverviewRow,
  type MockDatabaseData,
  replaceMockDatabaseData,
} from "./mockDatabaseState";
import { minMax, sleep } from "./util/utils";

export type { MockDatabaseData } from "./mockDatabaseState";
export { createMockDatabaseData } from "./mockDatabaseState";

export interface MockDatabaseConfig {
  readonly latency: { readonly min: number; readonly max: number };
  readonly data?: MockDatabaseData;
}

export const mockDatabase = (config: MockDatabaseConfig) => {
  const implementation: DatabasePluginImplementation = (() => {
    const data = config.data ?? createMockDatabaseData();
    const state = createMockDatabaseState(data);
    let operationQueue: Promise<void> = Promise.resolve();

    const waitForLatency = (): Promise<void> =>
      sleep(minMax(config.latency.min, config.latency.max));

    const mutate = <TResult>(
      operation: () => Promise<TResult>,
    ): Promise<TResult> => {
      const result = operationQueue.then(async () => {
        await waitForLatency();
        return operation();
      });
      operationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const read = <TResult>(
      operation: () => Promise<TResult>,
    ): Promise<TResult> => mutate(operation);

    return {
      create: (input) => mutate(() => state.create(input)),
      update: (input) => mutate(() => state.update(input)),
      delete: (input) => mutate(() => state.delete(input)),
      count: (input) => read(() => state.count(input)),
      findOne: (input) => read(() => state.findOne(input)),
      findMany: (input) => read(() => state.findMany(input)),
      recordInsights: ({ event }) =>
        mutate(async () => {
          if (data.bundleEvents.has(event.id)) return;
          const previousHead = data.bundleEventHeads.get(event.install_id);
          for (const delta of insightsOverviewDeltas(event)) {
            const id = insightsOverviewId(delta.identity);
            const current = data.insightsOverview.get(id);
            data.insightsOverview.set(id, {
              ...(current ?? emptyOverviewRow(delta.identity)),
              downloads: (current?.downloads ?? 0) + delta.downloads,
              launches: (current?.launches ?? 0) + delta.launches,
              failedLaunches:
                (current?.failedLaunches ?? 0) + delta.failedLaunches,
              launchUsers:
                delta.launchIdentity === undefined
                  ? (current?.launchUsers ?? null)
                  : addInsightsDistinct(
                      current?.launchUsers,
                      delta.launchIdentity,
                    ),
              activityUsers:
                delta.activityIdentity === undefined
                  ? (current?.activityUsers ?? null)
                  : addInsightsDistinct(
                      current?.activityUsers,
                      delta.activityIdentity,
                    ),
            });
          }
          if (isNewerInsightsHead(event, previousHead)) {
            if (previousHead !== undefined) {
              updateMockDistribution(data, headDistribution(previousHead), -1);
            }
            updateMockDistribution(
              data,
              insightsDistributionIdentity(event),
              1,
            );
            data.bundleEventHeads.set(event.install_id, {
              id: event.id,
              receivedAtMs: event.received_at_ms,
              platform: event.platform,
              channel: event.channel,
              appVersion: event.app_version,
              currentReleaseId:
                event.type === "UPDATE_DOWNLOADED"
                  ? event.from_release_id
                  : event.to_release_id,
            });
          }
          data.bundleEvents.set(event.id, structuredClone(event));
        }),
      getReleaseActivity: (input) =>
        read(async () => getMockReleaseActivity(data, input)),
      getAppUsage: (input) => read(async () => getMockAppUsage(data, input)),
      findLatestInsightsEvents: (input) =>
        read(async () => {
          const rows = latestEvents(data.bundleEvents.values()).filter((row) =>
            matchesMockDatabaseWhere<"bundle_events">(
              row,
              latestInsightsWhere(input),
            ),
          );
          return rows
            .sort((a, b) => compareInsightsText(a.install_id, b.install_id))
            .slice(0, "installId" in input ? 1 : input.limit);
        }),
      countLatestInsightsEvents: (input) =>
        read(
          async () =>
            latestEvents(data.bundleEvents.values()).filter((row) =>
              latestInsightsCountGroups(input).some((where) =>
                matchesMockDatabaseWhere<"bundle_events">(row, where),
              ),
            ).length,
        ),
      insertChannel: (input) =>
        mutate(async () => {
          const existing = [...data.channels.values()].find(
            ({ name }) => name === input.row.name,
          );
          if (existing) return { row: existing, inserted: false };
          await state.create({ model: "channels", data: input.row });
          return { row: input.row, inserted: true };
        }),
      deleteChannel: ({ id }) =>
        mutate(async () => {
          if (!data.channels.has(id)) {
            return { deleted: false, reason: "not_found" };
          }
          if (
            [...data.releases.values()].some((row) => row.channel_id === id)
          ) {
            return { deleted: false, reason: "not_empty" };
          }
          data.channels.delete(id);
          return { deleted: true };
        }),
      transaction: (callback) =>
        mutate(async () => {
          const transactionData = cloneMockDatabaseData(data);
          const result = await callback(
            createMockDatabaseState(transactionData),
          );
          replaceMockDatabaseData(data, transactionData);
          return result;
        }),
    };
  })();
  return createDatabasePluginAdapter("mockDatabase", implementation);
};

const latestEvents = (events: Iterable<BundleEventRow>): BundleEventRow[] => {
  const latest = new Map<string, BundleEventRow>();
  for (const event of events) {
    const previous = latest.get(event.install_id);
    if (
      !previous ||
      event.received_at_ms > previous.received_at_ms ||
      (event.received_at_ms === previous.received_at_ms &&
        event.id > previous.id)
    )
      latest.set(event.install_id, event);
  }
  return [...latest.values()];
};

const emptyOverviewRow = (
  identity: InsightsOverviewIdentity,
): MockInsightsOverviewRow => ({
  ...identity,
  downloads: 0,
  launches: 0,
  failedLaunches: 0,
  latestInstallations: 0,
  launchUsers: null,
  activityUsers: null,
});

const isNewerInsightsHead = (
  event: BundleEventRow,
  head: MockBundleEventHead | undefined,
): boolean =>
  head === undefined ||
  event.received_at_ms > head.receivedAtMs ||
  (event.received_at_ms === head.receivedAtMs && event.id > head.id);

const headDistribution = (
  head: MockBundleEventHead,
): InsightsOverviewIdentity => ({
  scopeKind: "distribution",
  releaseKind: head.currentReleaseId === null ? "embedded" : "specific",
  releaseId: head.currentReleaseId ?? "",
  channel: head.channel,
  platform: head.platform,
  appVersionKind: "specific",
  appVersion: head.appVersion,
  periodKind: "latest",
  bucketStartMs: Math.floor(head.receivedAtMs / 3_600_000) * 3_600_000,
});

const updateMockDistribution = (
  data: MockDatabaseData,
  identity: InsightsOverviewIdentity,
  amount: -1 | 1,
): void => {
  const id = insightsOverviewId(identity);
  const current = data.insightsOverview.get(id);
  const next = (current?.latestInstallations ?? 0) + amount;
  if (next < 0) throw new Error("inconsistent Insights distribution");
  data.insightsOverview.set(id, {
    ...(current ?? emptyOverviewRow(identity)),
    latestInstallations: next,
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

const activityMetrics = (
  rows: readonly MockInsightsOverviewRow[],
  ranged: boolean,
) => {
  const days = new Map<number, { launches: number; failedLaunches: number }>();
  for (const row of rows) {
    const startMs = Math.floor(row.bucketStartMs / 86_400_000) * 86_400_000;
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

const getMockReleaseActivity = (
  data: MockDatabaseData,
  input: InsightsGetReleaseActivityInput,
): InsightsGetReleaseActivityResult => {
  const allRows = [...data.insightsOverview.values()];
  const ranged = input.timeRange !== undefined;
  const rows = allRows.filter((row) => {
    if (input.scope !== undefined) {
      return (
        row.scopeKind === "channel" &&
        row.channel === input.scope.channel &&
        row.platform === input.scope.platform &&
        row.periodKind === "hour" &&
        row.bucketStartMs >= input.timeRange.start &&
        row.bucketStartMs < input.timeRange.end
      );
    }
    if (input.timeRange === undefined) {
      return input.releases.some(
        (release) =>
          insightsOverviewId(releaseIdentity(release)) ===
          insightsOverviewId(row),
      );
    }
    return (
      row.scopeKind === "release" &&
      row.periodKind === "hour" &&
      row.bucketStartMs >= input.timeRange.start &&
      row.bucketStartMs < input.timeRange.end &&
      input.releases.some(
        (release) =>
          row.releaseId === release.releaseId &&
          row.channel === release.channel &&
          row.platform === release.platform,
      )
    );
  });
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data:
      input.scope !== undefined
        ? [{ scope: input.scope, metrics: activityMetrics(rows, true) }]
        : input.releases.map((release) => ({
            release,
            metrics: activityMetrics(
              rows.filter(
                (row) =>
                  row.releaseId === release.releaseId &&
                  row.channel === release.channel &&
                  row.platform === release.platform,
              ),
              ranged,
            ),
          })),
    measuredAtMs: Date.now(),
  };
};

const getMockAppUsage = (
  data: MockDatabaseData,
  input: InsightsGetAppUsageInput,
): InsightsGetAppUsageResult => {
  const rows = [...data.insightsOverview.values()];
  const usage = rows.filter(
    (row) =>
      row.scopeKind === "usage" &&
      row.channel === input.channel &&
      row.platform === input.platform &&
      row.appVersionKind ===
        (input.appVersion === undefined ? "all" : "specific") &&
      row.appVersion === (input.appVersion ?? "") &&
      row.periodKind === "hour" &&
      row.bucketStartMs >= input.timeRange.start &&
      row.bucketStartMs < input.timeRange.end,
  );
  const distribution = rows.filter(
    (row) =>
      row.scopeKind === "distribution" &&
      row.channel === input.channel &&
      (input.platform === "all" || row.platform === input.platform) &&
      (input.appVersion === undefined || row.appVersion === input.appVersion) &&
      row.bucketStartMs >= input.timeRange.start &&
      row.bucketStartMs < input.timeRange.end &&
      row.latestInstallations > 0,
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
                row.bucketStartMs >= startMs &&
                row.bucketStartMs < startMs + input.intervalMs,
            )
            .map(({ activityUsers }) => activityUsers),
        ),
      ),
    });
  }
  const group = (field: "appVersion" | "platform") => {
    const values = new Map<string, number>();
    for (const row of distribution) {
      values.set(
        row[field],
        (values.get(row[field]) ?? 0) + row.latestInstallations,
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
    const releaseId = row.releaseKind === "specific" ? row.releaseId : null;
    const key = JSON.stringify([row.appVersion, row.platform, releaseId]);
    const previous = bundles.get(key);
    bundles.set(key, {
      appVersion: row.appVersion,
      platform: row.platform as "ios" | "android",
      releaseId,
      installations: (previous?.installations ?? 0) + row.latestInstallations,
    });
  }
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
    bundleDistribution: [...bundles.values()],
    measuredAtMs: Date.now(),
  };
};

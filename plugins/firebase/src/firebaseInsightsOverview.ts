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
  insightsDistributionIdentity,
  insightsOverviewDeltas,
  insightsOverviewId,
  insightsOverviewValues,
  mergeInsightsDistinct,
  type InsightsOverviewIdentity,
} from "@hot-updater/plugin-core/internal";
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";

import type { FirebaseDatabaseCollections } from "./firebaseDatabasePersistence";

type OverviewRow = ReturnType<typeof insightsOverviewValues> & {
  readonly downloads: number;
  readonly launches: number;
  readonly failed_launches: number;
  readonly latest_installations: number;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
};

const emptyRow = (identity: InsightsOverviewIdentity): OverviewRow => ({
  ...insightsOverviewValues(identity),
  downloads: 0,
  launches: 0,
  failed_launches: 0,
  latest_installations: 0,
  launch_users: null,
  activity_users: null,
});

const row = (value: DocumentData | undefined): OverviewRow | undefined =>
  value as OverviewRow | undefined;

const isNewer = (event: BundleEventRow, current: BundleEventRow | null) =>
  current === null ||
  event.received_at_ms > current.received_at_ms ||
  (event.received_at_ms === current.received_at_ms && event.id > current.id);

export const recordFirebaseInsightsOverview = async ({
  transaction,
  collections,
  event,
  current,
}: {
  readonly transaction: Transaction;
  readonly collections: FirebaseDatabaseCollections;
  readonly event: BundleEventRow;
  readonly current: BundleEventRow | null;
}): Promise<void> => {
  const deltas = insightsOverviewDeltas(event);
  const advancesHead = isNewer(event, current);
  const identities = [
    ...deltas.map(({ identity }) => identity),
    ...(advancesHead && current !== null
      ? [insightsDistributionIdentity(current)]
      : []),
    ...(advancesHead ? [insightsDistributionIdentity(event)] : []),
  ];
  const references = new Map<string, DocumentReference<DocumentData>>();
  for (const identity of identities) {
    const id = insightsOverviewId(identity);
    references.set(id, collections.insightsOverview.doc(id));
  }
  const refs = [...references.values()];
  const snapshots = refs.length === 0 ? [] : await transaction.getAll(...refs);
  const rows = new Map<string, OverviewRow>();
  snapshots.forEach((snapshot, index) => {
    const value = row(snapshot.data());
    if (value !== undefined) rows.set(refs[index]!.id, value);
  });
  for (const delta of deltas) {
    const id = insightsOverviewId(delta.identity);
    const previous = rows.get(id) ?? emptyRow(delta.identity);
    rows.set(id, {
      ...previous,
      downloads: previous.downloads + delta.downloads,
      launches: previous.launches + delta.launches,
      failed_launches: previous.failed_launches + delta.failedLaunches,
      launch_users:
        delta.launchIdentity === undefined
          ? previous.launch_users
          : addInsightsDistinct(
              previous.launch_users ?? emptyInsightsDistinct(),
              delta.launchIdentity,
            ),
      activity_users:
        delta.activityIdentity === undefined
          ? previous.activity_users
          : addInsightsDistinct(
              previous.activity_users ?? emptyInsightsDistinct(),
              delta.activityIdentity,
            ),
    });
  }
  if (advancesHead && current !== null) {
    const identity = insightsDistributionIdentity(current);
    const id = insightsOverviewId(identity);
    const previous = rows.get(id);
    if (previous === undefined || previous.latest_installations < 1) {
      throw new Error("Insights distribution state is inconsistent");
    }
    rows.set(id, {
      ...previous,
      latest_installations: previous.latest_installations - 1,
    });
  }
  if (advancesHead) {
    const identity = insightsDistributionIdentity(event);
    const id = insightsOverviewId(identity);
    const previous = rows.get(id) ?? emptyRow(identity);
    rows.set(id, {
      ...previous,
      latest_installations: previous.latest_installations + 1,
    });
  }
  for (const [id, value] of rows) {
    transaction.set(collections.insightsOverview.doc(id), value);
  }
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

const hourStarts = (start: number, end: number): readonly number[] => {
  const values: number[] = [];
  for (
    let value = Math.ceil(start / 3_600_000) * 3_600_000;
    value < end;
    value += 3_600_000
  ) {
    values.push(value);
  }
  return values;
};

const loadRows = async (
  db: Firestore,
  references: readonly DocumentReference<DocumentData>[],
): Promise<readonly OverviewRow[]> => {
  const result: OverviewRow[] = [];
  for (let offset = 0; offset < references.length; offset += 250) {
    const snapshots = await db.getAll(
      ...references.slice(offset, offset + 250),
    );
    for (const snapshot of snapshots) {
      const value = row(snapshot.data());
      if (value !== undefined) result.push(value);
    }
  }
  return result;
};

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

export const getFirebaseReleaseActivity = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
  input: InsightsGetReleaseActivityInput,
): Promise<InsightsGetReleaseActivityResult> => {
  const identities: InsightsOverviewIdentity[] = [];
  if (input.scope !== undefined) {
    for (const bucketStartMs of hourStarts(
      input.timeRange.start,
      input.timeRange.end,
    )) {
      identities.push({
        scopeKind: "channel",
        releaseKind: "all",
        releaseId: "",
        channel: input.scope.channel,
        platform: input.scope.platform,
        appVersionKind: "all",
        appVersion: "",
        periodKind: "hour",
        bucketStartMs,
      });
    }
  } else {
    for (const release of input.releases) {
      if (input.timeRange === undefined) {
        identities.push(releaseIdentity(release, "lifetime", 0));
      } else {
        for (const bucketStartMs of hourStarts(
          input.timeRange.start,
          input.timeRange.end,
        )) {
          identities.push(releaseIdentity(release, "hour", bucketStartMs));
        }
      }
    }
  }
  const rows = await loadRows(
    db,
    identities.map((identity) =>
      collections.insightsOverview.doc(insightsOverviewId(identity)),
    ),
  );
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

export const getFirebaseAppUsage = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
  input: InsightsGetAppUsageInput,
): Promise<InsightsGetAppUsageResult> => {
  const usageIdentities: InsightsOverviewIdentity[] = hourStarts(
    input.timeRange.start,
    input.timeRange.end,
  ).map((bucketStartMs) => ({
    scopeKind: "usage",
    releaseKind: "all",
    releaseId: "",
    channel: input.channel,
    platform: input.platform,
    appVersionKind: input.appVersion === undefined ? "all" : "specific",
    appVersion: input.appVersion ?? "",
    periodKind: "hour",
    bucketStartMs,
  }));
  const usage = await loadRows(
    db,
    usageIdentities.map((identity) =>
      collections.insightsOverview.doc(insightsOverviewId(identity)),
    ),
  );
  let distributionQuery = collections.insightsOverview
    .where("scope_kind", "==", "distribution")
    .where("channel", "==", input.channel)
    .where("period_kind", "==", "latest");
  if (input.platform !== "all") {
    distributionQuery = distributionQuery.where(
      "platform",
      "==",
      input.platform,
    );
  }
  if (input.appVersion !== undefined) {
    distributionQuery = distributionQuery.where(
      "app_version",
      "==",
      input.appVersion,
    );
  }
  const distributionSnapshot = await distributionQuery
    .where("bucket_start_ms", ">=", input.timeRange.start)
    .where("bucket_start_ms", "<", input.timeRange.end)
    .get();
  const distribution = distributionSnapshot.docs
    .map((document) => row(document.data())!)
    .filter((value) => value.latest_installations > 0);
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

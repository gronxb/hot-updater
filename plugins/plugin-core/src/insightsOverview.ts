import type { BundleEventRow } from "./types/internal";

export type InsightsOverviewIdentity = {
  readonly scopeKind: "release" | "channel" | "usage" | "distribution";
  readonly releaseKind: "all" | "specific" | "embedded";
  readonly releaseId: string;
  readonly channel: string;
  readonly platform: "all" | "ios" | "android";
  readonly appVersionKind: "all" | "specific";
  readonly appVersion: string;
  readonly periodKind: "lifetime" | "hour" | "latest";
  readonly bucketStartMs: number;
};

export type InsightsOverviewDelta = {
  readonly identity: InsightsOverviewIdentity;
  readonly downloads: number;
  readonly launches: number;
  readonly failedLaunches: number;
  readonly launchIdentity?: string;
  readonly activityIdentity?: string;
};

const encodeIdentity = (identity: InsightsOverviewIdentity): string =>
  [
    identity.scopeKind,
    identity.releaseKind,
    identity.releaseId,
    identity.channel,
    identity.platform,
    identity.appVersionKind,
    identity.appVersion,
    identity.periodKind,
    String(identity.bucketStartMs),
  ]
    .map((value) => `${new TextEncoder().encode(value).length}:${value}`)
    .join("");

const fnv = (value: string, seed: bigint): string => {
  let result = seed;
  for (const byte of new TextEncoder().encode(value)) {
    result ^= BigInt(byte);
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result.toString(16).padStart(16, "0");
};

export const insightsOverviewId = (
  identity: InsightsOverviewIdentity,
): string => {
  const value = encodeIdentity(identity);
  return `${fnv(value, 0xcbf29ce484222325n)}${fnv(value, 0x84222325cbf29ce4n)}`;
};

export const insightsOverviewValues = (identity: InsightsOverviewIdentity) => ({
  id: insightsOverviewId(identity),
  scope_kind: identity.scopeKind,
  release_kind: identity.releaseKind,
  release_id: identity.releaseId,
  channel: identity.channel,
  platform: identity.platform,
  app_version_kind: identity.appVersionKind,
  app_version: identity.appVersion,
  period_kind: identity.periodKind,
  bucket_start_ms: identity.bucketStartMs,
});

const hour = (value: number): number =>
  Math.floor(value / 3_600_000) * 3_600_000;

export const currentInsightsReleaseId = (
  event: BundleEventRow,
): string | null =>
  event.type === "UPDATE_DOWNLOADED"
    ? event.from_release_id
    : event.to_release_id;

export const insightsDistributionIdentity = (
  event: BundleEventRow,
): InsightsOverviewIdentity => {
  const releaseId = currentInsightsReleaseId(event);
  return {
    scopeKind: "distribution",
    releaseKind: releaseId === null ? "embedded" : "specific",
    releaseId: releaseId ?? "",
    channel: event.channel,
    platform: event.platform,
    appVersionKind: "specific",
    appVersion: event.app_version,
    periodKind: "latest",
    bucketStartMs: hour(event.received_at_ms),
  };
};

export const insightsOverviewDeltas = (
  event: BundleEventRow,
): readonly InsightsOverviewDelta[] => {
  const bucketStartMs = hour(event.received_at_ms);
  const counters = new Map<string, InsightsOverviewDelta>();
  const append = (
    identity: InsightsOverviewIdentity,
    values: Pick<
      InsightsOverviewDelta,
      "downloads" | "launches" | "failedLaunches"
    > & {
      readonly launchIdentity?: string;
      readonly activityIdentity?: string;
    },
  ) => {
    const key = encodeIdentity(identity);
    const previous = counters.get(key);
    counters.set(key, {
      identity,
      downloads: (previous?.downloads ?? 0) + values.downloads,
      launches: (previous?.launches ?? 0) + values.launches,
      failedLaunches: (previous?.failedLaunches ?? 0) + values.failedLaunches,
      launchIdentity: previous?.launchIdentity ?? values.launchIdentity,
      activityIdentity: previous?.activityIdentity ?? values.activityIdentity,
    });
  };
  const metric = (
    releaseId: string | null,
    values: Pick<
      InsightsOverviewDelta,
      "downloads" | "launches" | "failedLaunches"
    >,
  ) => {
    const launchIdentity = values.launches > 0 ? event.install_id : undefined;
    if (releaseId !== null) {
      for (const [periodKind, start] of [
        ["lifetime", 0],
        ["hour", bucketStartMs],
      ] as const) {
        append(
          {
            scopeKind: "release",
            releaseKind: "specific",
            releaseId,
            channel: event.channel,
            platform: event.platform,
            appVersionKind: "all",
            appVersion: "",
            periodKind,
            bucketStartMs: start,
          },
          { ...values, ...(periodKind === "hour" ? { launchIdentity } : {}) },
        );
      }
    }
    append(
      {
        scopeKind: "channel",
        releaseKind: "all",
        releaseId: "",
        channel: event.channel,
        platform: event.platform,
        appVersionKind: "all",
        appVersion: "",
        periodKind: "hour",
        bucketStartMs,
      },
      { ...values, launchIdentity },
    );
  };

  if (event.type === "UPDATE_DOWNLOADED") {
    metric(event.to_release_id, {
      downloads: 1,
      launches: 0,
      failedLaunches: 0,
    });
  } else {
    metric(event.to_release_id, {
      downloads: 0,
      launches: 1,
      failedLaunches: 0,
    });
    if (event.type === "RECOVERED") {
      metric(event.from_release_id, {
        downloads: 0,
        launches: 0,
        failedLaunches: 1,
      });
    }
  }

  for (const platform of [event.platform, "all"] as const) {
    for (const appVersionKind of ["specific", "all"] as const) {
      append(
        {
          scopeKind: "usage",
          releaseKind: "all",
          releaseId: "",
          channel: event.channel,
          platform,
          appVersionKind,
          appVersion: appVersionKind === "specific" ? event.app_version : "",
          periodKind: "hour",
          bucketStartMs,
        },
        {
          downloads: 0,
          launches: 0,
          failedLaunches: 0,
          activityIdentity: event.install_id,
        },
      );
    }
  }
  return [...counters.values()];
};

import type { BundleEventRow } from "./eventRow";
import { isLateEvent, isLaunch } from "./schema";

export type InsightsOverviewIdentity = {
  readonly scopeKind: "release" | "channel" | "usage";
  readonly releaseKind: "all" | "specific";
  readonly releaseId: string;
  readonly channel: string;
  readonly platform: "all" | "ios" | "android";
  readonly appVersionKind: "all" | "specific";
  readonly appVersion: string;
  readonly periodKind: "lifetime" | "hour";
  readonly bucketStartMs: number;
};

export type InsightsOverviewDelta = {
  readonly identity: InsightsOverviewIdentity;
  readonly downloads: number;
  readonly applies: number;
  readonly failedLaunches: number;
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

/** A 128-bit hex key for a string: two FNV-1a 64 hashes with different seeds. */
export const insightsKey = (value: string): string =>
  `${fnv(value, 0xcbf29ce484222325n)}${fnv(value, 0x84222325cbf29ce4n)}`;

export const insightsOverviewId = (
  identity: InsightsOverviewIdentity,
): string => insightsKey(encodeIdentity(identity));

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

export const insightsOverviewDeltas = (
  event: BundleEventRow,
): readonly InsightsOverviewDelta[] => {
  const bucketStartMs = hour(event.received_at_ms);
  const counters = new Map<string, InsightsOverviewDelta>();
  const append = (
    identity: InsightsOverviewIdentity,
    values: Pick<
      InsightsOverviewDelta,
      "downloads" | "applies" | "failedLaunches"
    > & {
      readonly activityIdentity?: string;
    },
  ) => {
    const key = encodeIdentity(identity);
    const previous = counters.get(key);
    counters.set(key, {
      identity,
      downloads: (previous?.downloads ?? 0) + values.downloads,
      applies: (previous?.applies ?? 0) + values.applies,
      failedLaunches: (previous?.failedLaunches ?? 0) + values.failedLaunches,
      activityIdentity: previous?.activityIdentity ?? values.activityIdentity,
    });
  };
  const metric = (
    releaseId: string | null,
    values: Pick<
      InsightsOverviewDelta,
      "downloads" | "applies" | "failedLaunches"
    >,
  ) => {
    // Only a release's lifetime row counts applies: the bundle list reads
    // them there, and no windowed read sums them.
    const windowed = { ...values, applies: 0 };
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
          periodKind === "lifetime" ? values : windowed,
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
      windowed,
    );
  };

  // `applies` counts launches (`isLaunch`): an apply, or a kept UNCHANGED
  // row that moved the installation to a release with no apply report. A
  // launch or crash whose download report never arrived counts that download
  // too, so a release's downloads cover its launches and crashes. A late
  // download or apply counts nothing: its target was counted when it ran. A
  // failed update is counted by recordEvent itself.
  const implied =
    (event.metadata as { implied_download?: true }).implied_download === true
      ? 1
      : 0;
  if (!isLateEvent(event) && event.type === "UPDATE_DOWNLOADED") {
    metric(event.to_release_id, {
      downloads: 1,
      applies: 0,
      failedLaunches: 0,
    });
  } else if (!isLateEvent(event) && isLaunch(event)) {
    metric(event.to_release_id, {
      downloads: implied,
      applies: 1,
      failedLaunches: 0,
    });
  } else if (!isLateEvent(event) && event.type === "RECOVERED") {
    // The launch crashed on the bundle it left; returning to the one before
    // is no launch.
    metric(event.from_release_id, {
      downloads: implied,
      applies: 0,
      failedLaunches: 1,
    });
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
          applies: 0,
          failedLaunches: 0,
          activityIdentity: event.install_id,
        },
      );
    }
  }
  return [...counters.values()];
};

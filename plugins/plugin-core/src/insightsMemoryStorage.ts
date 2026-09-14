import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
} from "./insightsProjection";
import type {
  BundleEventRow,
  InsightsStorageAdapter,
  ReleaseReference,
} from "./types/internal";

type Summary = {
  active: number;
  pending: number;
  downloaded: number;
  recovered: number;
};

export const createMemoryInsightsStorage = (options?: {
  readonly onEvent?: (event: BundleEventRow) => void;
}): InsightsStorageAdapter => {
  const events = new Set<string>();
  const states = new Map<string, { revision: number; state: string }>();
  const markers = new Set<string>();
  const summaries = new Map<string, Summary>();
  const hourly = new Map<
    string,
    { downloaded: number; applied: number; recovered: number }
  >();
  let queue: Promise<void> = Promise.resolve();
  const exclusive = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    readRecordContext: ({ installId, lifetimeKey }) =>
      exclusive(() => {
        const current = states.get(installId);
        return {
          revision: String(current?.revision ?? 0),
          state: current?.state ?? null,
          lifetimeExists:
            lifetimeKey !== null &&
            markers.has(insightsLifetimeMarkerKey(lifetimeKey)),
        };
      }),
    commitPreparedEvent: (prepared) =>
      exclusive(() => {
        if (events.has(prepared.event.id)) {
          return { status: "duplicate" as const };
        }
        const actual = states.get(prepared.event.install_id)?.revision ?? 0;
        if (String(actual) !== prepared.expectedRevision) {
          return { status: "conflict" as const };
        }
        const markerKey =
          prepared.firstLifetime === null
            ? null
            : insightsLifetimeMarkerKey(prepared.firstLifetime);
        if (markerKey !== null && markers.has(markerKey)) {
          return { status: "conflict" as const };
        }
        events.add(prepared.event.id);
        options?.onEvent?.(structuredClone(prepared.event));
        states.set(prepared.event.install_id, {
          revision: actual + 1,
          state: prepared.nextState,
        });
        const add = (
          release: ReleaseReference,
          metric: keyof Summary,
          value: number,
        ) => {
          const key = insightsReleaseKey(release);
          const summary = summaries.get(key) ?? {
            active: 0,
            pending: 0,
            downloaded: 0,
            recovered: 0,
          };
          summary[metric] += value;
          if (summary[metric] < 0) throw new Error("Invalid Insights counter");
          summaries.set(key, summary);
        };
        for (const delta of prepared.currentDeltas) {
          add(delta.release, delta.metric, delta.delta);
        }
        if (prepared.firstLifetime !== null) {
          markers.add(markerKey!);
          add(prepared.firstLifetime.release, prepared.firstLifetime.metric, 1);
        }
        if (prepared.hourly !== null) {
          const value = prepared.hourly;
          const key = insightsHourlyBucketKey(value.release, value.hourStartMs);
          const bucket = hourly.get(key) ?? {
            downloaded: 0,
            applied: 0,
            recovered: 0,
          };
          bucket[value.metric] += 1;
          hourly.set(key, bucket);
        }
        return { status: "committed" as const };
      }),
    getReleaseActivity: (input) =>
      exclusive(() => ({
        coverage: { kind: "complete" as const, sinceMs: 0 },
        data: input.releases.map((release) => {
          const summary = summaries.get(insightsReleaseKey(release));
          const series =
            input.timeRange === undefined
              ? undefined
              : Array.from(
                  {
                    length:
                      (input.timeRange.end - input.timeRange.start) / 3_600_000,
                  },
                  (_, index) => input.timeRange!.start + index * 3_600_000,
                ).flatMap((startMs) => {
                  const point = hourly.get(
                    insightsHourlyBucketKey(release, startMs),
                  );
                  return point
                    ? [
                        {
                          startMs,
                          downloadedReports: point.downloaded,
                          appliedReports: point.applied,
                          recoveredReports: point.recovered,
                        },
                      ]
                    : [];
                });
          return {
            release,
            summary: {
              activeInstallations: summary?.active ?? 0,
              pendingInstallations: summary?.pending ?? 0,
              downloadedInstallations: summary?.downloaded ?? 0,
              recoveredInstallations: summary?.recovered ?? 0,
            },
            ...(series === undefined ? {} : { series }),
            measuredAtMs: Date.now(),
          };
        }),
      })),
  };
};

import { useQueries, useQuery } from "@tanstack/react-query";

import { insightsPeriodEnd, recoveryWindows } from "./insights-recovery";
import type { InsightsWindow } from "./insights-rpc";
import type { HealthChart } from "./insights-search";
import {
  DEFAULT_ADOPTION_RELEASES,
  type AdoptionRelease,
  type BundleEventType,
  type BundleEventsSeries,
  MAX_ADOPTION_RELEASES,
} from "./release-adoption";
import {
  getAdoptionReleaseRpc,
  getBundleEventsRpc,
  listAdoptionReleasesRpc,
} from "./release-adoption-rpc";

/** What each Release health chart reads per bundle. */
const READS: Record<HealthChart, readonly BundleEventType[]> = {
  adoption: ["UPDATE_APPLIED"],
  crashes: ["UPDATE_APPLIED", "RECOVERED"],
};

/** One compared bundle and the reports read for it so far. */
export type ComparedBundle = {
  readonly release: AdoptionRelease;
  readonly applied?: BundleEventsSeries;
  readonly recovered?: BundleEventsSeries;
  readonly error: Error | null;
};

/** What Release health shows: the period, the bundles, their reports. */
export type ReleaseHealthState = {
  readonly period: {
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
    readonly intervalMs: number;
  };
  /** The newest bundle deployments, newest first; undefined while loading. */
  readonly candidates: readonly AdoptionRelease[] | undefined;
  /** The compared bundles; undefined until they are known. */
  readonly releases: readonly ComparedBundle[] | undefined;
  /** True when the bundles are the default, not a choice. */
  readonly isDefault: boolean;
  readonly error: Error | null;
  readonly isFetching: boolean;
  readonly refresh: () => void;
};

/**
 * Release health's reads, each keyed by what it depends on: the newest
 * deployments by channel and platform, kept five minutes; a bundle the
 * newest leave out, kept; and one count series per bundle and report type,
 * so adding a bundle or opening the other chart reads only what is new.
 */
export function useReleaseHealth({
  platform,
  channel,
  window,
  releaseIds,
  focusReleaseId,
  chart,
}: {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  /** Chosen bundles; undefined, the focus and its previous, or the newest. */
  readonly releaseIds: readonly string[] | undefined;
  readonly focusReleaseId: string | undefined;
  readonly chart: HealthChart;
}): ReleaseHealthState {
  const { durationMs, intervalMs } = recoveryWindows[window];
  // Every series of one chart reads the same hours: the period ends with the
  // current hour, so a new hour reads them all again, together.
  const endMs = insightsPeriodEnd(Date.now());
  const scope = { platform, channel };
  const candidatesQuery = useQuery({
    queryKey: ["insights", "adoption-releases", scope],
    queryFn: () => listAdoptionReleasesRpc({ data: scope }),
    staleTime: 5 * 60_000,
  });
  const candidates = candidatesQuery.data;
  const focusIndex =
    focusReleaseId === undefined || candidates === undefined
      ? -1
      : candidates.findIndex((release) => release.releaseId === focusReleaseId);
  // A focus among the newest has its previous bundle there too, unless it is
  // the oldest of them.
  const focusQuery = useQuery({
    queryKey: ["insights", "adoption-release", scope, focusReleaseId, true],
    queryFn: () =>
      getAdoptionReleaseRpc({
        data: { ...scope, releaseId: focusReleaseId!, withPrevious: true },
      }),
    enabled:
      releaseIds === undefined &&
      focusReleaseId !== undefined &&
      candidates !== undefined &&
      (focusIndex === -1 || focusIndex === candidates.length - 1),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const known = new Map<string, AdoptionRelease>();
  for (const release of [
    ...(focusQuery.data?.release ? [focusQuery.data.release] : []),
    ...(focusQuery.data?.previous ? [focusQuery.data.previous] : []),
    // The newest list last, so a rolled-back bundle shows as it is now.
    ...(candidates ?? []),
  ])
    known.set(release.releaseId, release);
  const newest = (list: readonly AdoptionRelease[]) =>
    list
      .slice(0, DEFAULT_ADOPTION_RELEASES)
      .map((release) => release.releaseId);
  const chosen: readonly string[] | undefined =
    releaseIds !== undefined
      ? releaseIds.slice(0, MAX_ADOPTION_RELEASES)
      : candidates === undefined
        ? undefined
        : focusReleaseId === undefined
          ? newest(candidates)
          : focusIndex !== -1 && focusIndex < candidates.length - 1
            ? [focusReleaseId, candidates[focusIndex + 1]!.releaseId]
            : focusQuery.data === undefined
              ? undefined
              : focusQuery.data.release === null
                ? // A focus that is no bundle of this scope: the newest.
                  newest(candidates)
                : [
                    focusQuery.data.release.releaseId,
                    focusQuery.data.previous?.releaseId,
                  ].filter((id) => id !== undefined);
  // A chosen bundle the newest leave out, as from a copied link.
  const unknown = (chosen ?? []).filter(
    (releaseId) => !known.has(releaseId) && releaseId !== focusReleaseId,
  );
  const labelQueries = useQueries({
    queries: unknown.map((releaseId) => ({
      queryKey: ["insights", "adoption-release", scope, releaseId, false],
      queryFn: () => getAdoptionReleaseRpc({ data: { ...scope, releaseId } }),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  for (const query of labelQueries)
    if (query.data?.release)
      known.set(query.data.release.releaseId, query.data.release);
  const releases =
    chosen === undefined || labelQueries.some((query) => query.isPending)
      ? undefined
      : chosen.flatMap((releaseId) => {
          const release = known.get(releaseId);
          return release === undefined ? [] : [release];
        });
  const reads = (releases ?? []).flatMap((release) =>
    READS[chart].map((type) => ({ release, type })),
  );
  const seriesQueries = useQueries({
    queries: reads.map(({ release, type }) => {
      const data = {
        ...scope,
        window,
        endMs,
        bundleId: release.bundleId,
        type,
      };
      return {
        queryKey: ["insights", "bundle-events", data],
        queryFn: () => getBundleEventsRpc({ data }),
        staleTime: 30_000,
        // Keep a bundle's line while its next period loads.
        placeholderData: (
          previous: BundleEventsSeries | undefined,
        ): BundleEventsSeries | undefined =>
          previous?.bundleId === release.bundleId && previous.type === type
            ? previous
            : undefined,
      };
    }),
  });
  const seriesOf = (bundleId: string, type: BundleEventType) => {
    const index = reads.findIndex(
      (read) => read.release.bundleId === bundleId && read.type === type,
    );
    return index === -1 ? undefined : seriesQueries[index];
  };
  return {
    period: { startMs: endMs - durationMs, endMs, durationMs, intervalMs },
    candidates,
    releases: releases?.map((release) => {
      const applied = seriesOf(release.bundleId, "UPDATE_APPLIED");
      const recovered = seriesOf(release.bundleId, "RECOVERED");
      return {
        release,
        applied: applied?.data,
        recovered: recovered?.data,
        error: applied?.error ?? recovered?.error ?? null,
      };
    }),
    isDefault: releaseIds === undefined,
    error: candidatesQuery.error ?? focusQuery.error ?? null,
    isFetching:
      candidatesQuery.isFetching ||
      focusQuery.isFetching ||
      seriesQueries.some((query) => query.isFetching),
    refresh: () => {
      void candidatesQuery.refetch();
      for (const query of seriesQueries) void query.refetch();
    },
  };
}

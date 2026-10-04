import { useQueries, useQuery } from "@tanstack/react-query";

import { insightsPeriodEnd, recoveryWindows } from "./insights-recovery";
import {
  getDownloadsReleaseRpc,
  getReleaseDownloadsRpc,
  listDownloadsReleasesRpc,
} from "./insights-recovery-rpc";
import type { InsightsWindow } from "./insights-rpc";
import {
  DEFAULT_DOWNLOADS_RELEASES,
  type DownloadsRelease,
  MAX_DOWNLOADS_RELEASES,
  type ReleaseDownloadsSeries,
} from "./release-downloads";

/** What the Downloads chart shows: the period, the bundles, their series. */
export type ReleaseDownloadsState = {
  readonly period: {
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
    readonly intervalMs: number;
  };
  /** The newest bundle deployments, newest first; undefined while loading. */
  readonly candidates: readonly DownloadsRelease[] | undefined;
  /** The compared bundles; undefined until they are known. */
  readonly releases:
    | readonly {
        readonly release: DownloadsRelease;
        readonly series: ReleaseDownloadsSeries | undefined;
        readonly error: Error | null;
      }[]
    | undefined;
  /** True when the bundles are the newest, not a choice. */
  readonly isDefault: boolean;
  readonly error: Error | null;
  readonly isFetching: boolean;
  readonly refresh: () => void;
};

/**
 * The Downloads tab's reads, each keyed by what it depends on: the newest
 * deployments by channel and platform, kept five minutes; a bundle the newest
 * leave out, kept; and one series per bundle, so adding one reads only it.
 * Nothing reads while the tab is closed.
 */
export function useReleaseDownloads({
  platform,
  channel,
  window,
  releaseIds,
  focusReleaseId,
  enabled,
}: {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly window: InsightsWindow;
  /** Chosen bundles; undefined, the newest, or the focus and its previous. */
  readonly releaseIds: readonly string[] | undefined;
  readonly focusReleaseId: string | undefined;
  readonly enabled: boolean;
}): ReleaseDownloadsState {
  const { durationMs, intervalMs } = recoveryWindows[window];
  // Every series of one chart reads the same hours: the period ends with the
  // current hour, so a new hour reads them all again, together.
  const endMs = insightsPeriodEnd(Date.now());
  const scope = { platform, channel };
  const candidatesQuery = useQuery({
    queryKey: ["insights", "downloads-releases", scope],
    queryFn: () => listDownloadsReleasesRpc({ data: scope }),
    enabled,
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
    queryKey: ["insights", "downloads-release", scope, focusReleaseId, true],
    queryFn: () =>
      getDownloadsReleaseRpc({
        data: { ...scope, releaseId: focusReleaseId!, withPrevious: true },
      }),
    enabled:
      enabled &&
      releaseIds === undefined &&
      focusReleaseId !== undefined &&
      candidates !== undefined &&
      (focusIndex === -1 || focusIndex === candidates.length - 1),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const known = new Map<string, DownloadsRelease>();
  for (const release of [
    ...(candidates ?? []),
    ...(focusQuery.data?.release ? [focusQuery.data.release] : []),
    ...(focusQuery.data?.previous ? [focusQuery.data.previous] : []),
  ])
    known.set(release.releaseId, release);
  const chosen: readonly string[] | undefined =
    releaseIds !== undefined
      ? releaseIds.slice(0, MAX_DOWNLOADS_RELEASES)
      : candidates === undefined
        ? undefined
        : focusReleaseId === undefined
          ? candidates
              .slice(0, DEFAULT_DOWNLOADS_RELEASES)
              .map((release) => release.releaseId)
          : focusIndex !== -1 && focusIndex < candidates.length - 1
            ? [focusReleaseId, candidates[focusIndex + 1]!.releaseId]
            : focusQuery.data === undefined
              ? undefined
              : focusQuery.data.release === null
                ? // A focus that is no bundle of this scope: the newest.
                  candidates
                    .slice(0, DEFAULT_DOWNLOADS_RELEASES)
                    .map((release) => release.releaseId)
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
      queryKey: ["insights", "downloads-release", scope, releaseId, false],
      queryFn: () => getDownloadsReleaseRpc({ data: { ...scope, releaseId } }),
      enabled,
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  for (const query of labelQueries)
    if (query.data?.release)
      known.set(query.data.release.releaseId, query.data.release);
  const labelsPending = labelQueries.some((query) => query.isPending);
  const releases =
    chosen === undefined || (enabled && labelsPending)
      ? undefined
      : chosen.flatMap((releaseId) => {
          const release = known.get(releaseId);
          return release === undefined ? [] : [release];
        });
  const seriesQueries = useQueries({
    queries: (releases ?? []).map((release) => ({
      queryKey: [
        "insights",
        "downloads",
        { ...scope, window, endMs, releaseId: release.releaseId },
      ],
      queryFn: () =>
        getReleaseDownloadsRpc({
          data: { ...scope, window, endMs, releaseId: release.releaseId },
        }),
      enabled,
      staleTime: 30_000,
      // Keep a bundle's line while its next period loads.
      placeholderData: (
        previous: ReleaseDownloadsSeries | undefined,
      ): ReleaseDownloadsSeries | undefined =>
        previous?.releaseId === release.releaseId ? previous : undefined,
    })),
  });
  return {
    period: { startMs: endMs - durationMs, endMs, durationMs, intervalMs },
    candidates,
    releases: releases?.map((release, index) => ({
      release,
      series: seriesQueries[index]?.data,
      error: seriesQueries[index]?.error ?? null,
    })),
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

import type {
  InsightsReads,
  InsightsUpdateFailures,
} from "@hot-updater/server/plugins";

import {
  checkFailureRate,
  failureRate,
  readUpdateFailuresInput,
  type UpdateFailuresInput,
  type UpdateFailuresReport,
} from "../insights-failures";
import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";

const total = (
  reports: readonly InsightsUpdateFailures[],
  count: (report: InsightsUpdateFailures) => number,
) => reports.reduce((sum, report) => sum + count(report), 0);

/** Counts summed by key, most first, then in key order. */
const summed = <T extends { readonly events: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  merge: (first: T, rows: readonly T[]) => T,
): T[] => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups]
    .map(([key, group]) => ({ key, row: merge(group[0]!, group) }))
    .sort(
      (left, right) =>
        right.row.events - left.row.events ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    )
    .map(({ row }) => row);
};

/**
 * Both platforms' failures as one report. An installation runs on one
 * platform, so its counts and installation estimates add up; the period is
 * complete only where both are.
 */
export function mergeUpdateFailures(
  reports: readonly InsightsUpdateFailures[],
): InsightsUpdateFailures {
  if (reports.length === 1) return reports[0]!;
  const sinceMs = reports.map(({ coverage }) => coverage.sinceMs);
  const latestSince = sinceMs.includes(null)
    ? null
    : Math.max(...(sinceMs as number[]));
  const checks = reports.flatMap((report) =>
    report.checks ? [report.checks] : [],
  );
  const breakdowns = reports.flatMap((report) => report.breakdown ?? []);
  return {
    coverage:
      latestSince !== null &&
      reports.every(({ coverage }) => coverage.kind === "complete")
        ? { kind: "complete", sinceMs: latestSince }
        : { kind: "partial", sinceMs: latestSince },
    measuredAtMs: Math.min(...reports.map((report) => report.measuredAtMs)),
    failedUpdates: total(reports, (report) => report.failedUpdates),
    failedInstallations: total(reports, (report) => report.failedInstallations),
    downloads: total(reports, (report) => report.downloads),
    patchDownloads: total(reports, (report) => report.patchDownloads),
    patchFallbacks: total(reports, (report) => report.patchFallbacks),
    ...(checks.length === 0
      ? {}
      : {
          checks: {
            failures: checks.reduce((sum, row) => sum + row.failures, 0),
            failedInstallations: checks.reduce(
              (sum, row) => sum + row.failedInstallations,
              0,
            ),
            activeInstallations: checks.reduce(
              (sum, row) => sum + row.activeInstallations,
              0,
            ),
          },
        }),
    ...(reports.some((report) => report.breakdown)
      ? {
          breakdown: summed(
            breakdowns,
            ({ stage, reason }) => JSON.stringify([stage, reason]),
            (first, group) => ({
              stage: first.stage,
              reason: first.reason,
              events: group.reduce((sum, row) => sum + row.events, 0),
              details: summed(
                group.flatMap((row) => row.details),
                ({ resource, httpStatus, originCode, transport }) =>
                  JSON.stringify([resource, httpStatus, originCode, transport]),
                (detail, details) => ({
                  ...detail,
                  events: details.reduce((sum, row) => sum + row.events, 0),
                }),
              ),
            }),
          ),
        }
      : {}),
  };
}

/** A release's or a channel's update failures over a period that ends with the current hour. */
export async function getUpdateFailuresReport(
  reads: Pick<InsightsReads, "getUpdateFailures">,
  input: UpdateFailuresInput,
  now = Date.now(),
): Promise<UpdateFailuresReport> {
  readUpdateFailuresInput(input);
  const end = insightsPeriodEnd(now);
  const timeRange =
    input.window === undefined
      ? undefined
      : {
          start: Math.max(0, end - recoveryWindows[input.window].durationMs),
          end,
        };
  const scope = {
    channel: input.channel,
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
  };
  // Both platforms: one read of each, merged.
  const read = async (range: typeof timeRange) =>
    mergeUpdateFailures(
      await Promise.all(
        (input.platform === "all"
          ? (["ios", "android"] as const)
          : [input.platform]
        ).map((platform) =>
          reads.getUpdateFailures({
            ...scope,
            platform,
            ...(range === undefined ? {} : { timeRange: range }),
          }),
        ),
      ),
    );
  const previousRange =
    timeRange && timeRange.start >= timeRange.end - timeRange.start
      ? {
          start: timeRange.start - (timeRange.end - timeRange.start),
          end: timeRange.start,
        }
      : undefined;
  const [failures, previous] = await Promise.all([
    read(timeRange),
    previousRange === undefined ? undefined : read(previousRange),
  ]);
  return {
    ...failures,
    startMs: timeRange?.start ?? null,
    endMs: end,
    ...(previous === undefined
      ? {}
      : {
          previous: {
            attemptRate: failureRate(previous),
            checkRate: previous.checks
              ? checkFailureRate(previous.checks)
              : null,
            complete:
              previous.coverage.kind === "complete" &&
              failures.coverage.kind === "complete",
          },
        }),
  };
}

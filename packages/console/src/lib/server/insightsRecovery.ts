import { extractTimestampFromUUIDv7 } from "@hot-updater/plugin-core";
import { isUUIDv7 } from "@hot-updater/protocol";
import type {
  InsightsModel,
  ReleaseActivityMetrics,
} from "@hot-updater/server/plugins/insights";

import {
  insightsPeriodEnd,
  readRecoveryInput,
  recoveryWindows,
  type RecoveryInput,
  type RecoveryReport,
  type ReleaseAdoption,
} from "../insights-recovery";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Series = NonNullable<ReleaseActivityMetrics["series"]>;

/** Hourly points summed into UTC days, leaving out days without reports. */
const dailyPoints = (hourly: Series): Series => {
  const days = new Map<number, Series[number]>();
  for (const point of hourly) {
    if (point.downloads + point.launches + point.failedLaunches === 0) continue;
    const startMs = point.startMs - (point.startMs % DAY_MS);
    const day = days.get(startMs);
    days.set(
      startMs,
      day === undefined
        ? { ...point, startMs }
        : {
            startMs,
            downloads: day.downloads + point.downloads,
            launches: day.launches + point.launches,
            failedLaunches: day.failedLaunches + point.failedLaunches,
          },
    );
  }
  return [...days.values()];
};

/**
 * The period's hourly downloads in the chart's intervals, from the hour the
 * release was deployed when that falls in the period.
 */
const adoptionOf = (
  releaseId: string,
  hourly: Series,
  start: number,
  intervalMs: number,
): ReleaseAdoption => {
  const deployedAtMs = isUUIDv7(releaseId)
    ? extractTimestampFromUUIDv7(releaseId)
    : null;
  const from =
    deployedAtMs === null
      ? start
      : Math.max(start, deployedAtMs - (deployedAtMs % HOUR_MS));
  const intervals = new Map<number, number>();
  for (const point of hourly) {
    if (point.startMs < from) continue;
    const startMs = point.startMs - ((point.startMs - from) % intervalMs);
    intervals.set(startMs, (intervals.get(startMs) ?? 0) + point.downloads);
  }
  let totalDownloads = 0;
  return {
    deployedAtMs,
    intervalMs,
    points: [...intervals].map(([startMs, downloads]) => {
      totalDownloads += downloads;
      return { startMs, downloads, totalDownloads };
    }),
  };
};

export async function getRecoveryReport(
  model: InsightsModel,
  input: RecoveryInput,
  now = Date.now(),
): Promise<RecoveryReport> {
  readRecoveryInput(input);
  const end = insightsPeriodEnd(now);
  const start = Math.max(0, end - recoveryWindows[input.window].durationMs);
  const [result, distribution] = await Promise.all([
    model.getReleaseActivity(
      input.releaseId === undefined
        ? {
            scope: { platform: input.platform, channel: input.channel },
            timeRange: { start, end },
          }
        : {
            releases: [
              {
                releaseId: input.releaseId,
                platform: input.platform,
                channel: input.channel,
              },
            ],
            timeRange: { start, end },
            // Hourly, for the adoption intervals; days are their sums.
            intervalMs: HOUR_MS,
          },
    ),
    model.getDistributionHistory({
      platform: input.platform,
      channel: input.channel,
      timeRange: {
        start: start - (start % DAY_MS),
        end: Math.ceil(end / DAY_MS) * DAY_MS,
      },
    }),
  ]);
  const metrics = result.data[0]?.metrics;
  const series =
    input.releaseId === undefined
      ? (metrics?.series ?? [])
      : dailyPoints(metrics?.series ?? []);
  // The launches counter counts each installation once per UTC day it
  // launched, so it reads as active days, and per day as daily active
  // installations.
  return {
    distribution,
    downloads: metrics?.downloads ?? 0,
    activeInstallations: metrics?.uniqueUsers ?? 0,
    activeDays: metrics?.launches ?? 0,
    failedLaunches: metrics?.failedLaunches ?? 0,
    points: series.map((point) => ({
      startMs: point.startMs,
      dailyActiveInstallations: point.launches,
      failedLaunches: point.failedLaunches,
    })),
    adoption:
      input.releaseId === undefined
        ? null
        : adoptionOf(
            input.releaseId,
            metrics?.series ?? [],
            start,
            recoveryWindows[input.window].intervalMs,
          ),
    startMs: start,
    endMs: end,
    measuredAtMs: result.measuredAtMs,
    coverage: result.coverage,
  };
}

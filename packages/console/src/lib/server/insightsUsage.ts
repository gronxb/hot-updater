import type { InsightsModel } from "@hot-updater/plugin-core";

import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";
import {
  readAppUsageInput,
  type AppUsageInput,
  type AppUsageReport,
  type UsageWindow,
} from "../insights-usage";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * What a period reads, ending with the current hour. The 12-month period is
 * 52 weeks of whole UTC days, the last one today, so it reads the daily
 * counts: the hourly ones are kept 90 days.
 */
const usageRange = (window: UsageWindow, now: number) => {
  const end = insightsPeriodEnd(now);
  if (window === "12m") {
    const lastDay = Math.ceil(end / DAY_MS) * DAY_MS;
    return {
      start: Math.max(0, lastDay - 52 * WEEK_MS),
      end,
      intervalMs: WEEK_MS,
    };
  }
  const { durationMs, intervalMs } = recoveryWindows[window];
  return { start: Math.max(0, end - durationMs), end, intervalMs };
};

export async function getAppUsageReport(
  model: InsightsModel,
  input: AppUsageInput,
  now = Date.now(),
): Promise<AppUsageReport> {
  readAppUsageInput(input);
  const { start, end, intervalMs } = usageRange(input.window, now);
  const report = await model.getAppUsage({
    channel: input.channel,
    platform: input.platform,
    ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
    timeRange: { start, end },
    intervalMs,
  });
  return {
    bundleDistribution: report.bundleDistribution,
    activeInstallations: report.activeInstallations,
    sinceMs:
      report.coverage.sinceMs === null
        ? start
        : Math.max(start, report.coverage.sinceMs),
    distributionSinceMs: start - (start % DAY_MS),
    beforeReceivedAtMs: end,
    intervalMs,
    truncated: report.coverage.kind === "partial",
    appVersions: report.appVersions,
    versions: report.versions,
    platforms: report.platforms,
    points: report.points,
  };
}

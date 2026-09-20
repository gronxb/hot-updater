import type { InsightsModel } from "@hot-updater/plugin-core";

import { recoveryWindows } from "../insights-recovery";
import {
  readAppUsageInput,
  type AppUsageInput,
  type AppUsageReport,
} from "../insights-usage";

export async function getAppUsageReport(
  model: InsightsModel,
  input: AppUsageInput,
  now = Date.now(),
): Promise<AppUsageReport> {
  readAppUsageInput(input);
  const { intervalMs, durationMs } = recoveryWindows[input.window];
  const end = Math.floor(now / 3_600_000) * 3_600_000;
  const start = Math.max(0, end - durationMs);
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
    beforeReceivedAtMs: end,
    intervalMs,
    truncated: report.coverage.kind === "partial",
    appVersions: report.appVersions,
    versions: report.versions,
    platforms: report.platforms,
    points: report.points,
  };
}

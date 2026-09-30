import type { InsightsModel } from "@hot-updater/server/plugins/insights";

import {
  insightsPeriodEnd,
  readRecoveryInput,
  recoveryWindows,
  type RecoveryInput,
  type RecoveryReport,
} from "../insights-recovery";

export async function getRecoveryReport(
  model: InsightsModel,
  input: RecoveryInput,
  now = Date.now(),
): Promise<RecoveryReport> {
  readRecoveryInput(input);
  const end = insightsPeriodEnd(now);
  const start = Math.max(0, end - recoveryWindows[input.window].durationMs);
  const result = await model.getReleaseActivity(
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
        },
  );
  const metrics = result.data[0]?.metrics;
  // The launches counter counts each installation once per UTC day it
  // launched, so it reads as active days, and per day as daily active
  // installations.
  return {
    downloads: metrics?.downloads ?? 0,
    activeInstallations: metrics?.uniqueUsers ?? 0,
    activeDays: metrics?.launches ?? 0,
    failedLaunches: metrics?.failedLaunches ?? 0,
    points: (metrics?.series ?? []).map((point) => ({
      startMs: point.startMs,
      dailyActiveInstallations: point.launches,
      failedLaunches: point.failedLaunches,
    })),
    startMs: start,
    endMs: end,
    measuredAtMs: result.measuredAtMs,
    coverage: result.coverage,
  };
}

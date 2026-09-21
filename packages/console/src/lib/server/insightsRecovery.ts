import type { InsightsModel } from "@hot-updater/plugin-core";

import {
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
  const end = Math.floor(now / 3_600_000) * 3_600_000;
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
  return {
    downloads: metrics?.downloads ?? 0,
    uniqueUsers: metrics?.uniqueUsers ?? 0,
    launches: metrics?.launches ?? 0,
    failedLaunches: metrics?.failedLaunches ?? 0,
    points: metrics?.series ?? [],
    startMs: start,
    endMs: end,
    measuredAtMs: result.measuredAtMs,
    coverage: result.coverage,
  };
}

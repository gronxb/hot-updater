import {
  readUpdateFailuresInput,
  type UpdateFailuresInput,
  type UpdateFailuresReport,
} from "../insights-failures";
import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";
import type { ConsoleInsightsReads } from "./adminInsights";

/** A release's or a channel's update failures over a period that ends with the current hour. */
export async function getUpdateFailuresReport(
  reads: Pick<ConsoleInsightsReads, "getUpdateFailures">,
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
  const failures = await reads.getUpdateFailures({
    platform: input.platform,
    channel: input.channel,
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
    ...(timeRange === undefined ? {} : { timeRange }),
  });
  return { ...failures, startMs: timeRange?.start ?? null, endMs: end };
}

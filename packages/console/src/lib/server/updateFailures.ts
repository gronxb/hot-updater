import {
  checkFailureRate,
  failureRate,
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
  const scope = {
    platform: input.platform,
    channel: input.channel,
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
  };
  const previousRange =
    timeRange && timeRange.start >= timeRange.end - timeRange.start
      ? {
          start: timeRange.start - (timeRange.end - timeRange.start),
          end: timeRange.start,
        }
      : undefined;
  const [failures, previous] = await Promise.all([
    reads.getUpdateFailures({
      ...scope,
      ...(timeRange === undefined ? {} : { timeRange }),
    }),
    previousRange === undefined
      ? undefined
      : reads.getUpdateFailures({ ...scope, timeRange: previousRange }),
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

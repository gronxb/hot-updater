import type {
  FailureReportsInput,
  FailureReportsPage,
} from "../insights-errors";
import { readFailureReportsInput } from "../insights-errors";
import { recoveryWindows } from "../insights-recovery";
import type { InsightsEventRow } from "../insights-view";
import type { ConsoleInsightsReads } from "./adminInsights";

/** Bounded raw-event reads, with continuation even when a batch finds no failures. */
export async function listFailureReports(
  reads: Pick<ConsoleInsightsReads, "listEvents" | "getRetention">,
  input: FailureReportsInput,
): Promise<FailureReportsPage> {
  readFailureReportsInput(input);
  const { rawDays } = await reads.getRetention();
  const duration = Math.min(
    90 * 86_400_000,
    rawDays * 86_400_000,
    input.window ? recoveryWindows[input.window].durationMs : Infinity,
  );
  const sinceMs = Math.max(0, input.beforeReceivedAtMs - duration);
  const data: InsightsEventRow[] = [];
  let cursor = input.cursor;
  let scanned = 0;
  for (let batch = 0; batch < 5; batch += 1) {
    const page = await reads.listEvents({
      sinceMs,
      beforeReceivedAtMs: input.beforeReceivedAtMs,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    scanned += page.data.length;
    data.push(
      ...page.data.filter(
        (event) =>
          event.type === "UPDATE_FAILED" &&
          event.platform === input.platform &&
          event.channel === input.channel &&
          (input.releaseId === undefined ||
            (event.failure?.stage !== "check" &&
              event.toReleaseId === input.releaseId)),
      ),
    );
    cursor = page.nextCursor ?? undefined;
    if (!cursor || data.length >= 50) break;
  }
  return { data, scanned, sinceMs, nextCursor: cursor ?? null };
}

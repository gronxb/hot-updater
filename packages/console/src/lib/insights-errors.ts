import type { UpdateFailuresInput } from "./insights-failures";
import { readUpdateFailuresInput } from "./insights-failures";
import type { InsightsEventRow } from "./insights-view";

export type FailureReportsInput = UpdateFailuresInput & {
  readonly beforeReceivedAtMs: number;
  readonly cursor?: string;
};

export type FailureReportsPage = {
  readonly data: readonly InsightsEventRow[];
  readonly nextCursor: string | null;
  readonly scanned: number;
  readonly sinceMs: number;
};

export function readFailureReportsInput(input: FailureReportsInput) {
  readUpdateFailuresInput(input);
  if (
    !Number.isSafeInteger(input.beforeReceivedAtMs) ||
    input.beforeReceivedAtMs < 0 ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== "string" ||
        !input.cursor.length ||
        input.cursor.length > 8_192))
  ) {
    throw new Error("Invalid failure report range or cursor.");
  }
  return input;
}

/** Exact text and reported context only; never guess a cause from the message. */
export function groupFailureReports(events: readonly InsightsEventRow[]) {
  const groups = new Map<string, InsightsEventRow[]>();
  for (const event of events) {
    if (event.type !== "UPDATE_FAILED" || !event.failure) continue;
    const f = event.failure;
    const key = JSON.stringify([
      f.stage,
      f.reason,
      f.errorMessage ?? null,
      f.resource ?? null,
      f.httpStatus ?? null,
      f.originCode ?? null,
      f.transport ?? null,
    ]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, reports]) => ({
      key,
      reports: reports.sort((a, b) => b.receivedAtMs - a.receivedAtMs),
      installations: new Set(reports.map((event) => event.installId)).size,
    }))
    .sort(
      (a, b) =>
        b.reports.length - a.reports.length ||
        b.reports[0]!.receivedAtMs - a.reports[0]!.receivedAtMs,
    );
}

export type FailureGroup = ReturnType<typeof groupFailureReports>[number];

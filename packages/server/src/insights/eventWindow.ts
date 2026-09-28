import type { InsightsListEventsInput } from "@hot-updater/plugin-core";

const DAY_MS = 86_400_000;

/** The most UTC days one day-partitioned event list call reads. */
export const EVENT_LIST_DAYS = 90;

/**
 * The earliest receipt time one `listEvents` call reads: `sinceMs`, or the
 * start of the 90th UTC day down from the page's top (its cursor, else its
 * cutoff), whichever is later. Installation history is one index range, so
 * it reads back to `sinceMs`.
 */
export const eventListStart = (
  input: Pick<
    InsightsListEventsInput,
    "filter" | "sinceMs" | "beforeReceivedAtMs" | "after"
  >,
): number => {
  const sinceMs = input.sinceMs ?? 0;
  if (input.filter.kind === "installationMovement") return sinceMs;
  const top = input.after?.receivedAtMs ?? input.beforeReceivedAtMs - 1;
  const topDay = top - (top % DAY_MS);
  return Math.max(sinceMs, topDay - (EVENT_LIST_DAYS - 1) * DAY_MS);
};

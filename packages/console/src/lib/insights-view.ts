import type { EventHistoryRow, InstallationRow } from "@hot-updater/server";

export type InsightsEventRow = EventHistoryRow;
export type InsightsInstallationViewRow = InstallationRow;

export type InsightsViewPage<TRow> = {
  readonly data: readonly TRow[];
  readonly nextCursor: string | null;
};

export const outcomeLabels = {
  downloaded: "Downloaded reports",
  applied: "Applied reports",
  recovered: "Recovered-from reports",
  unchanged: "No-change reports",
} as const;

const DAY_MS = 86_400_000;

/** The time ranges an event list reads, shortest first. */
export const eventRanges = {
  "24h": { period: "24 hours", durationMs: DAY_MS },
  "7d": { period: "7 days", durationMs: 7 * DAY_MS },
  "30d": { period: "30 days", durationMs: 30 * DAY_MS },
  "90d": { period: "90 days", durationMs: 90 * DAY_MS },
} as const;

export type EventRange = keyof typeof eventRanges;

export const EVENT_RANGES = Object.keys(eventRanges) as readonly EventRange[];

export const DEFAULT_EVENT_RANGE: EventRange = "7d";

/** The next longer range, or undefined for the longest. */
export const widerEventRange = (range: EventRange): EventRange | undefined =>
  EVENT_RANGES[EVENT_RANGES.indexOf(range) + 1];

/**
 * The receipt interval [sinceMs, beforeReceivedAtMs) a range covers. The end
 * stays fixed while the list pages, so every page reads the same interval.
 */
export const eventRangeBounds = (
  range: EventRange,
  beforeReceivedAtMs: number,
) => ({
  beforeReceivedAtMs,
  sinceMs: Math.max(0, beforeReceivedAtMs - eventRanges[range].durationMs),
});

import type { ParsedLocation } from "@tanstack/react-router";

import {
  DEFAULT_EVENT_RANGE,
  EVENT_RANGES,
  type EventRange,
} from "../lib/insights-view";

export type InsightsPaginationState = {
  readonly eventsBack?: readonly string[];
  readonly searchBack?: readonly string[];
  readonly historyBack?: readonly string[];
};

declare module "@tanstack/react-router" {
  interface HistoryState {
    insightsPagination?: InsightsPaginationState;
  }
}

const readCursor = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const readEventRange = (value: unknown): EventRange | undefined =>
  EVENT_RANGES.find((range) => range === value);

/**
 * The installations route's scroll-restoration key: every visit to one page
 * of the event list shares its scroll position, and a lookup keeps its own
 * for each history entry.
 */
export function installationsScrollRestorationKey(location: ParsedLocation) {
  const search = validateInstallationsSearch(location.search);
  return search.query === undefined && search.installId === undefined
    ? `/installations?eventsBefore=${search.eventsBefore ?? "new"}&eventsRange=${search.eventsRange ?? DEFAULT_EVENT_RANGE}&eventsCursor=${search.eventsCursor ?? "first"}`
    : location.state.__TSR_key!;
}

export function validateInstallationsSearch(search: Record<string, unknown>) {
  return {
    query: typeof search.query === "string" ? search.query : undefined,
    installId:
      typeof search.installId === "string" ? search.installId : undefined,
    eventsCursor: readCursor(search.eventsCursor),
    eventsBefore: readTimestamp(search.eventsBefore),
    eventsRange: readEventRange(search.eventsRange),
    searchCursor: readCursor(search.searchCursor),
    historyCursor: readCursor(search.historyCursor),
    historyBefore: readTimestamp(search.historyBefore),
  };
}

import type { ParsedLocation } from "@tanstack/react-router";

const readCursor = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

export function getInsightsScrollRestorationKey(location: ParsedLocation) {
  if (location.pathname === "/installations") {
    const search = validateInstallationsSearch(location.search);
    if (search.query === undefined && search.installId === undefined) {
      return `/installations?eventsBefore=${search.eventsBefore ?? "new"}&eventsCursor=${search.eventsCursor ?? "first"}`;
    }
  }
  return location.state.__TSR_key!;
}

export function validateInstallationsSearch(search: Record<string, unknown>) {
  return {
    query: typeof search.query === "string" ? search.query : undefined,
    installId:
      typeof search.installId === "string" ? search.installId : undefined,
    eventsCursor: readCursor(search.eventsCursor),
    eventsBefore: readTimestamp(search.eventsBefore),
    searchCursor: readCursor(search.searchCursor),
    historyCursor: readCursor(search.historyCursor),
    historyBefore: readTimestamp(search.historyBefore),
  };
}

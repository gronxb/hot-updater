import type { ParsedLocation } from "@tanstack/react-router";

export function getInsightsScrollRestorationKey(location: ParsedLocation) {
  if (location.pathname === "/installations") {
    const search = validateInstallationsSearch(location.search);
    if (!search.query?.trim() && !search.installId) {
      return `/installations?historyOffset=${search.historyOffset}`;
    }
  }
  return location.state.__TSR_key!;
}

export function validateInstallationsSearch(search: Record<string, unknown>) {
  return {
    query: typeof search.query === "string" ? search.query : undefined,
    installId:
      typeof search.installId === "string" ? search.installId : undefined,
    searchOffset:
      typeof search.searchOffset === "number" &&
      Number.isSafeInteger(search.searchOffset) &&
      search.searchOffset >= 0
        ? search.searchOffset
        : 0,
    historyOffset:
      typeof search.historyOffset === "number" &&
      Number.isSafeInteger(search.historyOffset) &&
      search.historyOffset >= 0
        ? search.historyOffset
        : 0,
    ...(typeof search.eventsOffset === "number" &&
    Number.isSafeInteger(search.eventsOffset) &&
    search.eventsOffset >= 0
      ? { eventsOffset: search.eventsOffset }
      : {}),
  };
}

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
  };
}

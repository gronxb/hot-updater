const readCursor = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readCursorStack = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;

export function validateInsightsSearch(search: Record<string, unknown>) {
  return {
    bundleCursor: readCursor(search.bundleCursor),
    bundleBack: readCursorStack(search.bundleBack),
    bundlePublicationId: readCursor(search.bundlePublicationId),
  };
}

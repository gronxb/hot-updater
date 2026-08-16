export interface ReleaseSearch {
  afterReleaseId?: string;
  beforeReleaseId?: string;
  bundleId?: string;
  channelId?: string;
  enabled?: boolean;
  page?: number;
  platform?: "ios" | "android";
  releaseId?: string;
  targetAppVersion?: string;
}

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

export function validateReleaseSearch(
  search: Record<string, unknown>,
): ReleaseSearch {
  const parsedPage =
    typeof search.page === "number"
      ? search.page
      : typeof search.page === "string"
        ? Number(search.page)
        : undefined;
  const beforeReleaseId = optionalString(search.beforeReleaseId);
  const afterReleaseId = beforeReleaseId
    ? undefined
    : optionalString(search.afterReleaseId);
  const enabled =
    search.enabled === true || search.enabled === "true"
      ? true
      : search.enabled === false || search.enabled === "false"
        ? false
        : undefined;

  return {
    afterReleaseId,
    beforeReleaseId,
    bundleId: optionalString(search.bundleId),
    channelId: optionalString(search.channelId),
    enabled,
    page:
      parsedPage !== undefined && Number.isInteger(parsedPage) && parsedPage > 1
        ? parsedPage
        : undefined,
    platform:
      search.platform === "ios" || search.platform === "android"
        ? search.platform
        : undefined,
    releaseId: optionalString(search.releaseId),
    targetAppVersion: optionalString(search.targetAppVersion),
  };
}

export function updateReleaseFilters(
  current: ReleaseSearch,
  filters: Partial<
    Pick<
      ReleaseSearch,
      "bundleId" | "channelId" | "enabled" | "platform" | "targetAppVersion"
    >
  >,
): ReleaseSearch {
  return {
    ...current,
    ...filters,
    afterReleaseId: undefined,
    beforeReleaseId: undefined,
    page: undefined,
    releaseId: undefined,
  };
}

import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
  Bundle,
  BundleEventAnalyticsResult,
  BundleEventOverview,
  BundleEventSummary,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
  PaginatedResult,
} from "@hot-updater/plugin-core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export const isBundle = (value: unknown): value is Bundle =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.platform === "ios" || value.platform === "android") &&
  typeof value.enabled === "boolean" &&
  typeof value.shouldForceUpdate === "boolean" &&
  typeof value.fileHash === "string" &&
  typeof value.channel === "string" &&
  typeof value.storageUri === "string";

const isPaginationInfo = (
  value: unknown,
): value is PaginatedResult["pagination"] =>
  isRecord(value) &&
  isNonNegativeInteger(value.total) &&
  typeof value.hasNextPage === "boolean" &&
  typeof value.hasPreviousPage === "boolean" &&
  isNonNegativeInteger(value.currentPage) &&
  value.currentPage >= 1 &&
  isNonNegativeInteger(value.totalPages);

export const isPaginatedResult = (value: unknown): value is PaginatedResult =>
  isRecord(value) &&
  Array.isArray(value.data) &&
  value.data.every(isBundle) &&
  isPaginationInfo(value.pagination);

export const isBundleEventSummary = (
  value: unknown,
): value is BundleEventSummary =>
  isRecord(value) &&
  isNonNegativeInteger(value.installed) &&
  isNonNegativeInteger(value.recovered);

export const isBundleEventOverview = (
  value: unknown,
): value is BundleEventOverview =>
  isRecord(value) &&
  isNonNegativeInteger(value.trackedInstallations) &&
  Array.isArray(value.bundles) &&
  value.bundles.every(
    (item) =>
      isRecord(item) &&
      typeof item.bundleId === "string" &&
      isNonNegativeInteger(item.installations),
  );

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isEventType = (value: unknown): value is "RECOVERED" | "UPDATE_APPLIED" =>
  value === "RECOVERED" || value === "UPDATE_APPLIED";

export const isInstallationHistoryRow = (
  value: unknown,
): value is InstallationHistoryRow =>
  isRecord(value) &&
  typeof value.id === "string" &&
  isEventType(value.type) &&
  typeof value.fromBundleId === "string" &&
  typeof value.toBundleId === "string" &&
  isNullableString(value.username) &&
  isNullableString(value.userId) &&
  (value.platform === "ios" || value.platform === "android") &&
  typeof value.appVersion === "string" &&
  typeof value.channel === "string" &&
  typeof value.cohort === "string" &&
  typeof value.receivedAtMs === "number" &&
  Number.isFinite(value.receivedAtMs);

export const isInstallationSearchRow = (
  value: unknown,
): value is InstallationSearchRow =>
  isRecord(value) &&
  typeof value.installId === "string" &&
  isNullableString(value.username) &&
  isNullableString(value.userId) &&
  typeof value.lastKnownBundleId === "string" &&
  isEventType(value.latestStatus) &&
  (value.platform === "ios" || value.platform === "android") &&
  typeof value.appVersion === "string" &&
  typeof value.channel === "string" &&
  typeof value.cohort === "string" &&
  typeof value.receivedAtMs === "number" &&
  Number.isFinite(value.receivedAtMs);

const isOffsetPagination = (
  value: unknown,
): value is OffsetPaginationResult<unknown>["pagination"] =>
  isRecord(value) &&
  isNonNegativeInteger(value.total) &&
  isNonNegativeInteger(value.limit) &&
  isNonNegativeInteger(value.offset);

export const isOffsetPaginationResult = <TData>(
  value: unknown,
  isData: (item: unknown) => item is TData,
): value is OffsetPaginationResult<TData> =>
  isRecord(value) &&
  Array.isArray(value.data) &&
  value.data.every(isData) &&
  isOffsetPagination(value.pagination);

export const isBundleEventAnalytics = (
  value: unknown,
): value is BundleEventAnalyticsResult => {
  if (
    !isRecord(value) ||
    !isBundleEventSummary(value.summary) ||
    !isRecord(value.series) ||
    !isRecord(value.cohorts) ||
    !isOffsetPaginationResult(value.recentEvents, isInstallationHistoryRow)
  ) {
    return false;
  }
  const isSeries = (candidate: unknown) =>
    Array.isArray(candidate) &&
    candidate.every(
      (item) =>
        isRecord(item) &&
        typeof item.bucketStartMs === "number" &&
        Number.isFinite(item.bucketStartMs) &&
        typeof item.value === "number" &&
        Number.isFinite(item.value),
    );
  const isCohorts = (candidate: unknown) =>
    Array.isArray(candidate) &&
    candidate.every(
      (item) =>
        isRecord(item) &&
        typeof item.cohort === "string" &&
        typeof item.value === "number" &&
        Number.isFinite(item.value),
    );
  return (
    isSeries(value.series.installed) &&
    isSeries(value.series.recovered) &&
    isCohorts(value.cohorts.installed) &&
    isCohorts(value.cohorts.recovered)
  );
};

export const hasChannels = (
  value: unknown,
): value is { readonly data: { readonly channels: readonly string[] } } =>
  isRecord(value) &&
  isRecord(value.data) &&
  Array.isArray(value.data.channels) &&
  value.data.channels.every((channel) => typeof channel === "string");

export const isActiveInstallationOverview = (
  value: unknown,
  expectedWindow: ActiveInstallationWindow,
): value is ActiveInstallationOverview => {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.asOfMs) ||
    value.window !== expectedWindow ||
    !isNonNegativeInteger(value.activeInstallations) ||
    !Array.isArray(value.series) ||
    !Array.isArray(value.bundles)
  ) {
    return false;
  }
  const validSeries = value.series.every(
    (item) =>
      isRecord(item) &&
      isNonNegativeInteger(item.bucketStartMs) &&
      isNonNegativeInteger(item.value),
  );
  const validBundles = value.bundles.every(
    (item) =>
      isRecord(item) &&
      typeof item.bundleId === "string" &&
      isNonNegativeInteger(item.installations),
  );
  const bundleTotal = value.bundles.reduce(
    (total, item) =>
      total +
      (isRecord(item) && typeof item.installations === "number"
        ? item.installations
        : 0),
    0,
  );
  return (
    validSeries && validBundles && bundleTotal === value.activeInstallations
  );
};

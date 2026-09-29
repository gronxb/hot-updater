import type { ReleaseFilter } from "@hot-updater/plugin-core";

export interface ReleaseSearch {
  /** Releases newer than this id: the previous page. */
  afterReleaseId?: string;
  /** Releases older than this id: the next page. */
  beforeReleaseId?: string;
  bundleId?: string;
  channelId?: string;
  enabled?: boolean;
  platform?: "ios" | "android";
  releaseId?: string;
  /** One catalog scope: a channel, platform, and target kind. */
  scopeKey?: string;
}

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * The search a URL holds, reduced to one of the filter sets the release
 * indexes serve: a bundle, a scope (with enabled), or a channel with its
 * platform (with enabled). A channel without a platform lists iOS.
 */
export function validateReleaseSearch(
  search: Record<string, unknown>,
): ReleaseSearch {
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
  const bundleId = optionalString(search.bundleId);
  const scopeKey = bundleId ? undefined : optionalString(search.scopeKey);
  const channelId =
    bundleId || scopeKey ? undefined : optionalString(search.channelId);
  const platform =
    channelId === undefined
      ? undefined
      : search.platform === "android"
        ? "android"
        : "ios";

  return {
    afterReleaseId,
    beforeReleaseId,
    bundleId,
    channelId,
    enabled: scopeKey || channelId ? enabled : undefined,
    platform,
    releaseId: optionalString(search.releaseId),
    scopeKey,
  };
}

export function releaseFilterOf(search: ReleaseSearch): ReleaseFilter {
  const enabled =
    search.enabled === undefined ? {} : { enabled: search.enabled };
  if (search.bundleId) return { kind: "bundle", bundleId: search.bundleId };
  if (search.scopeKey) {
    return { kind: "scope", scopeKey: search.scopeKey, ...enabled };
  }
  if (search.channelId && search.platform) {
    return {
      kind: "channelPlatform",
      channelId: search.channelId,
      platform: search.platform,
      ...enabled,
    };
  }
  return { kind: "all" };
}

export function hasReleaseFilters(search: ReleaseSearch): boolean {
  return releaseFilterOf(search).kind !== "all";
}

/**
 * A new filter starts from the first page. A bundle or scope filter replaces
 * the others, and choosing a channel or platform clears them.
 */
export function updateReleaseFilters(
  current: ReleaseSearch,
  filters: Partial<
    Pick<
      ReleaseSearch,
      "bundleId" | "channelId" | "enabled" | "platform" | "scopeKey"
    >
  >,
): ReleaseSearch {
  const next = { ...current, ...filters };
  if (filters.bundleId)
    return validateReleaseSearch({ bundleId: next.bundleId });
  if (filters.scopeKey) {
    return validateReleaseSearch({
      scopeKey: next.scopeKey,
      enabled: next.enabled,
    });
  }
  if ("channelId" in filters || "platform" in filters) {
    return validateReleaseSearch({
      channelId: next.channelId,
      enabled: next.enabled,
      platform: next.platform,
    });
  }
  return validateReleaseSearch({
    bundleId: next.bundleId,
    channelId: next.channelId,
    enabled: next.enabled,
    platform: next.platform,
    scopeKey: next.scopeKey,
  });
}

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
  /** Whether a page's unreachable releases show; view state, no filter. */
  showUnreachable?: true;
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
    showUnreachable:
      search.showUnreachable === true || search.showUnreachable === "true"
        ? true
        : undefined,
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
 * the others, and choosing a channel or platform clears them. An open group
 * of unreachable releases stays open.
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
  const { showUnreachable } = current;
  if (filters.bundleId)
    return validateReleaseSearch({ bundleId: next.bundleId, showUnreachable });
  if (filters.scopeKey) {
    return validateReleaseSearch({
      scopeKey: next.scopeKey,
      enabled: next.enabled,
      showUnreachable,
    });
  }
  if ("channelId" in filters || "platform" in filters) {
    return validateReleaseSearch({
      channelId: next.channelId,
      enabled: next.enabled,
      platform: next.platform,
      showUnreachable,
    });
  }
  return validateReleaseSearch({
    bundleId: next.bundleId,
    channelId: next.channelId,
    enabled: next.enabled,
    platform: next.platform,
    scopeKey: next.scopeKey,
    showUnreachable,
  });
}

/** What a page of releases shows: its rows, and those collapsed under them. */
export interface ReleaseGroups<T> {
  readonly shown: readonly T[];
  readonly collapsed: readonly T[];
}

/**
 * Collapses a page's unreachable releases under its other ones, in their
 * order. A filter that asks for unreachable releases, Disabled or one
 * bundle, collapses none, nor does a page of only unreachable ones. The
 * selected release shows while the group is closed, among the others; in
 * an open group it stays where it is, so selecting it moves no row.
 */
export function groupUnreachableReleases<
  T extends { readonly id: string; readonly currentlyUnreachable: boolean },
>(releases: readonly T[], search: ReleaseSearch): ReleaseGroups<T> {
  if (search.enabled === false || search.bundleId !== undefined) {
    return { shown: releases, collapsed: [] };
  }
  const pinned = search.showUnreachable ? undefined : search.releaseId;
  const collapsed = releases.filter(
    (release) => release.currentlyUnreachable && release.id !== pinned,
  );
  if (collapsed.length === releases.length) {
    return { shown: releases, collapsed: [] };
  }
  return {
    shown: releases.filter((release) => !collapsed.includes(release)),
    collapsed,
  };
}

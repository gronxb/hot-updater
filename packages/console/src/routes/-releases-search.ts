import type { ChannelRow, ReleaseFilter } from "@hot-updater/plugin-core";

import { ALL_CHANNELS, DEFAULT_CHANNEL } from "@/lib/constants";

export interface ReleaseSearch {
  /** Releases newer than this id: the previous page. */
  afterReleaseId?: string;
  /** Releases older than this id: the next page. */
  beforeReleaseId?: string;
  bundleId?: string;
  channelId?: string;
  /** Every channel, where the list would open on the default one. */
  channels?: typeof ALL_CHANNELS;
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
  const channels =
    !bundleId && !scopeKey && !channelId && search.channels === ALL_CHANNELS
      ? ALL_CHANNELS
      : undefined;

  return {
    afterReleaseId,
    beforeReleaseId,
    bundleId,
    channelId,
    channels,
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
 * The search the list shows. A URL that names no channel, bundle, or scope
 * opens on the default channel's iOS releases, or on every channel when the
 * project has no such channel; undefined until the channel list, which the
 * page reads anyway, arrives. A link to one release that names no channel
 * shows every channel, so its row shows wherever it is.
 */
export function resolveReleaseSearch(
  search: ReleaseSearch,
  channels: readonly Pick<ChannelRow, "id" | "name">[] | undefined,
): ReleaseSearch | undefined {
  if (
    search.bundleId ||
    search.scopeKey ||
    search.channelId ||
    search.channels === ALL_CHANNELS
  ) {
    return search;
  }
  if (search.releaseId) return { ...search, channels: ALL_CHANNELS };
  if (channels === undefined) return undefined;
  const defaultChannel = channels.find(({ name }) => name === DEFAULT_CHANNEL);
  return defaultChannel
    ? validateReleaseSearch({ ...search, channelId: defaultChannel.id })
    : search;
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
      | "bundleId"
      | "channelId"
      | "channels"
      | "enabled"
      | "platform"
      | "scopeKey"
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
      channels: next.channels,
      enabled: next.enabled,
      platform: next.platform,
    });
  }
  return validateReleaseSearch({
    bundleId: next.bundleId,
    channelId: next.channelId,
    channels: next.channels,
    enabled: next.enabled,
    platform: next.platform,
    scopeKey: next.scopeKey,
  });
}

/**
 * Whether the list shows what it opens on, so Clear has nothing to clear;
 * true until the channel list arrives.
 */
export function showsDefaultReleases(
  search: ReleaseSearch,
  channels: readonly Pick<ChannelRow, "id" | "name">[] | undefined,
): boolean {
  const view = resolveReleaseSearch(search, channels);
  const opening = resolveReleaseSearch({}, channels);
  return (
    view === undefined ||
    opening === undefined ||
    JSON.stringify(releaseFilterOf(view)) ===
      JSON.stringify(releaseFilterOf(opening))
  );
}

import type {
  HotUpdaterCoreApi,
  ReleaseFilter,
  ReleaseRow,
} from "@hot-updater/plugin-core";

export interface ReleaseListInput {
  /** One of the filter sets the release indexes serve. */
  readonly filter: ReleaseFilter;
  /** Releases older than this id: the next page. */
  readonly beforeReleaseId?: string;
  /** Releases newer than this id: the previous page. */
  readonly afterReleaseId?: string;
  readonly limit: number;
}

export interface ReleaseListResult {
  /** Newest first. */
  readonly data: readonly ReleaseRow[];
  /** `beforeReleaseId` of the next page, when there may be older releases. */
  readonly next?: string;
  /** `afterReleaseId` of the previous page, when there may be newer releases. */
  readonly previous?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Release filter ${name} is required.`);
  }
  return value;
};

const enabledOf = (value: unknown) => {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error("Release filter enabled must be true or false.");
  }
  return { enabled: value };
};

/**
 * A release list's filter: none, a channel with its platform (and enabled),
 * a bundle, or a scope (and enabled). Those are the sets the release indexes
 * serve, so any other combination is refused.
 */
export const readReleaseFilter = (value: unknown): ReleaseFilter => {
  if (value === undefined) return { kind: "all" };
  if (!isRecord(value)) throw new Error("Invalid release filter.");
  switch (value.kind) {
    case "all":
      return { kind: "all" };
    case "channelPlatform": {
      if (value.platform !== "ios" && value.platform !== "android") {
        throw new Error("Release filter platform must be ios or android.");
      }
      return {
        kind: "channelPlatform",
        channelId: text(value.channelId, "channelId"),
        platform: value.platform,
        ...enabledOf(value.enabled),
      };
    }
    case "bundle":
      return { kind: "bundle", bundleId: text(value.bundleId, "bundleId") };
    case "scope":
      return {
        kind: "scope",
        scopeKey: text(value.scopeKey, "scopeKey"),
        ...enabledOf(value.enabled),
      };
    default:
      throw new Error("Invalid release filter.");
  }
};

/**
 * One page of releases, newest first, through the index the filter names:
 * each page reads only its own rows. `next` is set for a full page, so the
 * last page may lead to an empty one.
 */
export async function listReleases(
  core: Pick<HotUpdaterCoreApi, "listReleases">,
  input: ReleaseListInput,
): Promise<ReleaseListResult> {
  const { filter, limit } = input;
  if (input.afterReleaseId !== undefined) {
    // Newer releases, read oldest first from the cursor, then turned around.
    const data = (
      await core.listReleases({
        filter,
        order: "asc",
        after: input.afterReleaseId,
        limit,
      })
    ).reverse();
    const first = data[0]?.id;
    const last = data.at(-1)?.id;
    return {
      data,
      ...(last === undefined ? {} : { next: last }),
      ...(first !== undefined && data.length === limit
        ? { previous: first }
        : {}),
    };
  }
  const data = await core.listReleases({
    filter,
    order: "desc",
    limit,
    ...(input.beforeReleaseId === undefined
      ? {}
      : { after: input.beforeReleaseId }),
  });
  const first = data[0]?.id;
  const last = data.at(-1)?.id;
  return {
    data,
    ...(last !== undefined && data.length === limit ? { next: last } : {}),
    ...(first !== undefined && input.beforeReleaseId !== undefined
      ? { previous: first }
      : {}),
  };
}

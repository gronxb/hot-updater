import type {
  HotUpdaterCoreApi,
  ReleaseFilter,
} from "@hot-updater/plugin-core";

import { type FoldedPage, foldedPage, readFold } from "./foldedPage";
import {
  addReleaseReachability,
  type ReleaseListRow,
} from "./releaseReachability";

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

/** A page of releases that leads with the reachable ones. */
export type ReleaseFoldedPage = FoldedPage<ReleaseListRow>;

/**
 * Whether a filter asks for unreachable releases: Disabled, whose every
 * release no catalog serves, or one bundle. Its releases fold none.
 */
export const asksForUnreachable = (filter: ReleaseFilter): boolean =>
  filter.kind === "bundle" ||
  ((filter.kind === "scope" || filter.kind === "channelPlatform") &&
    filter.enabled === false);

/** The core reads a page makes, with each scope's catalog read once. */
const readingCatalogsOnce = (
  core: Pick<HotUpdaterCoreApi, "listReleases" | "getReleaseCatalogRow">,
) => {
  const catalogs = new Map<
    string,
    ReturnType<HotUpdaterCoreApi["getReleaseCatalogRow"]>
  >();
  return {
    listReleases: core.listReleases.bind(core),
    getReleaseCatalogRow: (scopeKey: string) => {
      if (!catalogs.has(scopeKey)) {
        catalogs.set(scopeKey, core.getReleaseCatalogRow(scopeKey));
      }
      return catalogs.get(scopeKey)!;
    },
  };
};

/**
 * One page of releases, newest first, that leads with the reachable ones
 * and the selected one: each run of unreachable releases between them folds.
 * It reads the filter's index a chunk at a time (at most
 * `FOLDED_PAGE_READ_BUDGET` rows), and each scope's catalog once. A filter
 * that asks for unreachable releases folds none.
 */
export function listReleaseFolds(
  core: Pick<HotUpdaterCoreApi, "listReleases" | "getReleaseCatalogRow">,
  {
    filter,
    beforeReleaseId,
    afterReleaseId,
    releaseId,
  }: {
    readonly filter: ReleaseFilter;
    readonly beforeReleaseId?: string;
    readonly afterReleaseId?: string;
    /** The selected release, which never folds. */
    readonly releaseId?: string;
  },
): Promise<ReleaseFoldedPage> {
  const reads = readingCatalogsOnce(core);
  const foldsNone = asksForUnreachable(filter);
  return foldedPage<ReleaseListRow>({
    read: async (input) =>
      addReleaseReachability(
        reads,
        await reads.listReleases({ filter, ...input }),
      ),
    classify: async (releases) =>
      new Set(
        releases
          .filter(
            (release) =>
              foldsNone ||
              !release.currentlyUnreachable ||
              release.id === releaseId,
          )
          .map(({ id }) => id),
      ),
    ...(beforeReleaseId === undefined ? {} : { before: beforeReleaseId }),
    ...(afterReleaseId === undefined ? {} : { after: afterReleaseId }),
  });
}

/** One chunk of a fold's releases, as `listReleaseFolds` folded them. */
export function readReleaseFold(
  core: Pick<HotUpdaterCoreApi, "listReleases" | "getReleaseCatalogRow">,
  {
    filter,
    ...fold
  }: {
    readonly filter: ReleaseFilter;
    readonly from?: string;
    readonly to: string;
    readonly after?: string;
  },
): Promise<{
  readonly rows: readonly ReleaseListRow[];
  readonly next?: string;
}> {
  const reads = readingCatalogsOnce(core);
  return readFold<ReleaseListRow>({
    read: async (input) =>
      addReleaseReachability(
        reads,
        await reads.listReleases({ filter, ...input }),
      ),
    ...fold,
  });
}

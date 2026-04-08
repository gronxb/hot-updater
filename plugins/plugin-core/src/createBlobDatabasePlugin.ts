import { getUpdateInfo as getManifestUpdateInfo } from "@hot-updater/js";
import { orderBy } from "es-toolkit";
import semver from "semver";

import { calculatePagination } from "./calculatePagination";
import { createDatabasePlugin } from "./createDatabasePlugin";
import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";
import { paginateBundles } from "./paginateBundles";
import { bundleMatchesQueryWhere, sortBundles } from "./queryBundles";
import type {
  AppVersionGetBundlesArgs,
  Bundle,
  DatabaseBundleCursor,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabasePluginHooks,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  UpdateInfo,
} from "./types";

interface BundleWithUpdateJsonKey extends Bundle {
  _updateJsonKey: string;
  _oldUpdateJsonKey?: string;
}

// Helper function to remove internal management keys
function removeBundleInternalKeys(bundle: BundleWithUpdateJsonKey): Bundle {
  const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
  return pureBundle;
}

// Helper function to normalize targetAppVersion for use as a storage key
// while preserving spaces between different semver comparators.
//
// For semver ranges with multiple comparators (e.g., ">= 5.7.0 <= 5.7.4"),
// spaces between the comparators are REQUIRED by npm/semver to parse correctly.
// Without the space, ">=5.7.0<=5.7.4" is invalid semver syntax.
//
// This function:
// 1. Removes spaces within a comparator (">= 5.7.0" → ">=5.7.0")
// 2. Preserves single spaces between different comparators (">=5.7.0 <=5.7.4")
// 3. Normalizes multiple spaces to single spaces
function normalizeTargetAppVersion(
  version: string | null | undefined,
): string | null {
  if (!version) return null;

  // First, normalize multiple whitespace to single spaces and trim
  let normalized = version.replace(/\s+/g, " ").trim();

  // Remove spaces between operators and version numbers within each comparator
  // Matches: operator (>=, <=, >, <, =, ~, ^) followed by optional space and version
  // This turns ">= 5.7.0" into ">=5.7.0" while keeping space between comparators
  normalized = normalized.replace(
    /([><=~^]+)\s+(\d)/g,
    (_match, operator, digit) => `${operator}${digit}`,
  );

  return normalized;
}

// Helper function to check if a version string is an exact version (not a range)
function isExactVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  // Normalize the version first to handle cases with spaces
  const normalized = normalizeTargetAppVersion(version);
  if (!normalized) return false;
  // semver.valid() returns the cleaned version string if it's a valid exact version
  // or null if it's not a valid version (includes ranges like x, *, ~, ^)
  return semver.valid(normalized) !== null;
}

/**
 * Get all normalized semver versions for a version string.
 * This handles the case where clients may request with different normalized forms.
 *
 * Examples:
 * - "1.0.0" generates ["1.0.0", "1.0", "1"]
 * - "2.1.0" generates ["2.1.0", "2.1"]
 * - "1.2.3" generates ["1.2.3"]
 */
function getSemverNormalizedVersions(version: string): string[] {
  // Normalize the version first to handle cases with spaces
  const normalized = normalizeTargetAppVersion(version) || version;
  const coerced = semver.coerce(normalized);
  if (!coerced) {
    return [normalized];
  }

  const versions = new Set<string>();

  // Always add the full version (1.0.0)
  versions.add(coerced.version);

  // Add "1.0" path if patch is 0
  if (coerced.patch === 0) {
    versions.add(`${coerced.major}.${coerced.minor}`);
  }

  // Add "1" path if both minor and patch are 0
  if (coerced.minor === 0 && coerced.patch === 0) {
    versions.add(`${coerced.major}`);
  }

  return Array.from(versions);
}

function resolveStorageTarget({
  targetAppVersion,
  fingerprintHash,
}: {
  targetAppVersion?: string | null;
  fingerprintHash?: string | null;
}): string {
  const target = normalizeTargetAppVersion(targetAppVersion) ?? fingerprintHash;
  if (!target) {
    throw new Error("target not found");
  }

  return target;
}

const DEFAULT_DESC_ORDER = { field: "id", direction: "desc" } as const;
const MANAGEMENT_INDEX_PREFIX = "_index";
const MANAGEMENT_INDEX_VERSION = 1 as const;
const DEFAULT_MANAGEMENT_INDEX_PAGE_SIZE = 128;
const ALL_SCOPE_CACHE_KEY = "*|*";

export interface BlobDatabasePluginConfig {
  managementIndexPageSize?: number;
}

interface ManagementIndexScope {
  channel?: string;
  platform?: Bundle["platform"];
}

interface ManagementIndexPageDescriptor {
  key: string;
  count: number;
  firstId: string;
  lastId: string;
}

interface ManagementIndexRoot {
  version: typeof MANAGEMENT_INDEX_VERSION;
  pageSize: number;
  total: number;
  channels?: string[];
  pages: ManagementIndexPageDescriptor[];
}

interface ManagementIndexScopeArtifact {
  cacheKey: string;
  rootKey: string;
  root: ManagementIndexRoot;
  pageKeys: string[];
}

interface ManagementIndexArtifacts {
  pages: Map<string, Bundle[]>;
  scopes: ManagementIndexScopeArtifact[];
}

function resolveManagementIndexPageSize(
  config: BlobDatabasePluginConfig,
): number {
  const pageSize =
    config.managementIndexPageSize ?? DEFAULT_MANAGEMENT_INDEX_PAGE_SIZE;

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("managementIndexPageSize must be a positive integer.");
  }

  return pageSize;
}

function sortManagedBundles(
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder = DEFAULT_DESC_ORDER,
): Bundle[] {
  return sortBundles(bundles, orderBy);
}

function isDefaultManagementOrder(orderBy?: DatabaseBundleQueryOrder): boolean {
  return (
    orderBy === undefined ||
    (orderBy.field === DEFAULT_DESC_ORDER.field &&
      orderBy.direction === DEFAULT_DESC_ORDER.direction)
  );
}

function hasUnsupportedManagementFilters(
  where?: DatabaseBundleQueryWhere,
): boolean {
  if (!where) {
    return false;
  }

  return Boolean(
    where.enabled !== undefined ||
    where.id !== undefined ||
    where.targetAppVersion !== undefined ||
    where.targetAppVersionIn !== undefined ||
    where.targetAppVersionNotNull !== undefined ||
    where.fingerprintHash !== undefined,
  );
}

function getSupportedManagementScope(
  where?: DatabaseBundleQueryWhere,
  orderBy?: DatabaseBundleQueryOrder,
): ManagementIndexScope | null {
  if (
    !isDefaultManagementOrder(orderBy) ||
    hasUnsupportedManagementFilters(where)
  ) {
    return null;
  }

  return {
    channel: where?.channel,
    platform: where?.platform,
  };
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value);
}

function getManagementScopeCacheKey({
  channel,
  platform,
}: ManagementIndexScope): string {
  return `${channel ?? "*"}|${platform ?? "*"}`;
}

function getManagementScopePrefix({
  channel,
  platform,
}: ManagementIndexScope): string {
  if (channel && platform) {
    return `${MANAGEMENT_INDEX_PREFIX}/channel/${encodeScopePart(channel)}/platform/${platform}`;
  }

  if (channel) {
    return `${MANAGEMENT_INDEX_PREFIX}/channel/${encodeScopePart(channel)}`;
  }

  if (platform) {
    return `${MANAGEMENT_INDEX_PREFIX}/platform/${platform}`;
  }

  return `${MANAGEMENT_INDEX_PREFIX}/all`;
}

function getManagementRootKey(scope: ManagementIndexScope): string {
  return `${getManagementScopePrefix(scope)}/root.json`;
}

function getManagementPageKey(
  scope: ManagementIndexScope,
  pageIndex: number,
): string {
  return `${getManagementScopePrefix(scope)}/pages/${String(pageIndex).padStart(4, "0")}.json`;
}

function createBundleWithUpdateJsonKey(
  bundle: Bundle,
): BundleWithUpdateJsonKey {
  const target = resolveStorageTarget(bundle);
  return {
    ...bundle,
    _updateJsonKey: `${bundle.channel}/${bundle.platform}/${target}/update.json`,
  };
}

function getPageStartOffsets(pages: ManagementIndexPageDescriptor[]): number[] {
  const startOffsets: number[] = [];
  let offset = 0;

  for (const page of pages) {
    startOffsets.push(offset);
    offset += page.count;
  }

  return startOffsets;
}

function createEmptyManagementResult(limit: number) {
  return {
    data: [] as Bundle[],
    pagination: calculatePagination(0, {
      limit,
      offset: 0,
    }),
  };
}

function buildManagementIndexArtifacts(
  allBundles: Bundle[],
  pageSize: number,
): ManagementIndexArtifacts {
  const sortedAllBundles = sortManagedBundles(allBundles);
  const pages = new Map<string, Bundle[]>();
  const scopes: ManagementIndexScopeArtifact[] = [];
  const channels = [
    ...new Set(sortedAllBundles.map((bundle) => bundle.channel)),
  ].sort();

  const addScope = (
    scope: ManagementIndexScope,
    scopeBundles: Bundle[],
    options?: { includeChannels?: boolean },
  ) => {
    if (!options?.includeChannels && scopeBundles.length === 0) {
      return;
    }

    const pageKeys: string[] = [];
    const pageDescriptors: ManagementIndexPageDescriptor[] = [];

    for (
      let pageIndex = 0;
      pageIndex * pageSize < scopeBundles.length;
      pageIndex++
    ) {
      const page = scopeBundles.slice(
        pageIndex * pageSize,
        (pageIndex + 1) * pageSize,
      );
      const key = getManagementPageKey(scope, pageIndex);
      pages.set(key, page);
      pageKeys.push(key);
      pageDescriptors.push({
        key,
        count: page.length,
        firstId: page[0]!.id,
        lastId: page.at(-1)!.id,
      });
    }

    const root: ManagementIndexRoot = {
      version: MANAGEMENT_INDEX_VERSION,
      pageSize,
      total: scopeBundles.length,
      pages: pageDescriptors,
      ...(options?.includeChannels ? { channels } : {}),
    };

    scopes.push({
      cacheKey: getManagementScopeCacheKey(scope),
      rootKey: getManagementRootKey(scope),
      root,
      pageKeys,
    });
  };

  addScope({}, sortedAllBundles, { includeChannels: true });

  for (const channel of channels) {
    const channelBundles = sortedAllBundles.filter(
      (bundle) => bundle.channel === channel,
    );
    addScope({ channel }, channelBundles);

    for (const platform of ["ios", "android"] as const) {
      const scopedBundles = channelBundles.filter(
        (bundle) => bundle.platform === platform,
      );
      addScope({ channel, platform }, scopedBundles);
    }
  }

  for (const platform of ["ios", "android"] as const) {
    const platformBundles = sortedAllBundles.filter(
      (bundle) => bundle.platform === platform,
    );
    addScope({ platform }, platformBundles);
  }

  return {
    pages,
    scopes,
  };
}

export interface BlobOperations {
  listObjects: (prefix: string) => Promise<string[]>;
  loadObject: <T>(key: string) => Promise<T | null>;
  uploadObject: <T>(key: string, data: T) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
  invalidatePaths: (paths: string[]) => Promise<void>;
  apiBasePath: string;
}

/**
 * Creates a blob storage-based database plugin with lazy initialization.
 *
 * @param name - The name of the database plugin
 * @param factory - Function that creates blob storage operations from config
 * @returns A double-curried function that lazily initializes the database plugin
 */
export const createBlobDatabasePlugin = <TConfig>({
  name,
  factory,
}: {
  name: string;
  factory: (config: TConfig) => BlobOperations;
}) => {
  return (config: TConfig, hooks?: DatabasePluginHooks) => {
    const managementIndexPageSize = resolveManagementIndexPageSize(
      config as TConfig & BlobDatabasePluginConfig,
    );
    const {
      listObjects,
      loadObject,
      uploadObject,
      deleteObject,
      invalidatePaths,
      apiBasePath,
    } = factory(config);
    // Map for O(1) lookup of bundles.
    const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
    // Temporary store for newly added or modified bundles.
    const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();
    const managementRootCache = new Map<string, ManagementIndexRoot | null>();

    const PLATFORMS = ["ios", "android"] as const;

    const getAllManagementArtifact = (
      artifacts: ManagementIndexArtifacts,
    ): ManagementIndexScopeArtifact => {
      const allArtifact = artifacts.scopes.find(
        (scope) => scope.cacheKey === ALL_SCOPE_CACHE_KEY,
      );
      if (!allArtifact) {
        throw new Error("all-bundles management index artifact not found");
      }

      return allArtifact;
    };

    const replaceManagementRootCache = (
      artifacts: ManagementIndexArtifacts,
    ) => {
      managementRootCache.clear();
      for (const scope of artifacts.scopes) {
        managementRootCache.set(scope.cacheKey, scope.root);
      }
    };

    const createHydratedBundle = (bundle: Bundle): BundleWithUpdateJsonKey => {
      const hydratedBundle = createBundleWithUpdateJsonKey(bundle);
      bundlesMap.set(hydratedBundle.id, hydratedBundle);
      return hydratedBundle;
    };

    const loadStoredManagementRoot = async (
      scope: ManagementIndexScope,
    ): Promise<ManagementIndexRoot | null> => {
      const cacheKey = getManagementScopeCacheKey(scope);
      const storedRoot = await loadObject<ManagementIndexRoot>(
        getManagementRootKey(scope),
      );
      if (storedRoot) {
        managementRootCache.set(cacheKey, storedRoot);
        return storedRoot;
      }

      managementRootCache.delete(cacheKey);
      return null;
    };

    const loadManagementPage = async (
      descriptor: ManagementIndexPageDescriptor,
      pageCache?: Map<string, Bundle[] | null>,
    ): Promise<Bundle[] | null> => {
      if (pageCache?.has(descriptor.key)) {
        return pageCache.get(descriptor.key) ?? null;
      }

      const page = await loadObject<Bundle[]>(descriptor.key);
      pageCache?.set(descriptor.key, page);
      return page;
    };

    const loadBundleFromManagementRoot = async (
      root: ManagementIndexRoot,
      bundleId: string,
    ): Promise<Bundle | null> => {
      const pageIndex = findPageIndexContainingId(root.pages, bundleId);
      if (pageIndex < 0) {
        return null;
      }

      const descriptor = root.pages[pageIndex]!;
      const page = await loadManagementPage(descriptor);
      if (!page) {
        return null;
      }

      return page.find((item) => item.id === bundleId) ?? null;
    };

    const loadAllBundlesFromRoot = async (
      root: ManagementIndexRoot,
    ): Promise<Bundle[] | null> => {
      const allBundles: Bundle[] = [];
      const pageCache = new Map<string, Bundle[] | null>();

      for (const descriptor of root.pages) {
        const page = await loadManagementPage(descriptor, pageCache);
        if (!page) {
          return null;
        }
        allBundles.push(...page);
      }

      return allBundles;
    };

    const persistManagementIndexArtifacts = async (
      nextArtifacts: ManagementIndexArtifacts,
      previousArtifacts?: ManagementIndexArtifacts,
    ): Promise<void> => {
      for (const [key, page] of nextArtifacts.pages.entries()) {
        await uploadObject(key, page);
      }

      for (const scope of nextArtifacts.scopes) {
        await uploadObject(scope.rootKey, scope.root);
      }

      if (!previousArtifacts) {
        return;
      }

      const nextPageKeys = new Set(nextArtifacts.pages.keys());
      const nextRootKeys = new Set(
        nextArtifacts.scopes.map((scope) => scope.rootKey),
      );

      for (const [key] of previousArtifacts.pages.entries()) {
        if (!nextPageKeys.has(key)) {
          await deleteObject(key).catch(() => {});
        }
      }

      for (const scope of previousArtifacts.scopes) {
        if (!nextRootKeys.has(scope.rootKey)) {
          await deleteObject(scope.rootKey).catch(() => {});
        }
      }
    };

    const ensureAllManagementRoot = async (): Promise<ManagementIndexRoot> => {
      const storedAllRoot = await loadStoredManagementRoot({});
      if (storedAllRoot && storedAllRoot.pageSize === managementIndexPageSize) {
        return storedAllRoot;
      }

      const rebuiltBundles = sortManagedBundles(
        (await reloadBundles()).map((bundle) =>
          removeBundleInternalKeys(bundle),
        ),
      );
      const nextArtifacts = buildManagementIndexArtifacts(
        rebuiltBundles,
        managementIndexPageSize,
      );
      const previousArtifacts = storedAllRoot
        ? buildManagementIndexArtifacts(rebuiltBundles, storedAllRoot.pageSize)
        : undefined;
      await persistManagementIndexArtifacts(nextArtifacts, previousArtifacts);
      replaceManagementRootCache(nextArtifacts);
      return getAllManagementArtifact(nextArtifacts).root;
    };

    const loadManagementScopeRoot = async (
      scope: ManagementIndexScope,
    ): Promise<ManagementIndexRoot | null> => {
      const cacheKey = getManagementScopeCacheKey(scope);
      if (cacheKey === ALL_SCOPE_CACHE_KEY) {
        return ensureAllManagementRoot();
      }

      const storedRoot = await loadStoredManagementRoot(scope);
      if (storedRoot) {
        return storedRoot;
      }

      await ensureAllManagementRoot();

      const storedScopedRoot = await loadStoredManagementRoot(scope);
      if (storedScopedRoot) {
        return storedScopedRoot;
      }

      managementRootCache.set(cacheKey, null);
      return null;
    };

    const loadAllBundlesForManagementFallback = async (): Promise<Bundle[]> => {
      const allRoot = await loadManagementScopeRoot({});
      if (allRoot) {
        const pagedBundles = await loadAllBundlesFromRoot(allRoot);
        if (pagedBundles) {
          return pagedBundles;
        }
      }

      return sortManagedBundles(
        (await reloadBundles()).map((bundle) =>
          removeBundleInternalKeys(bundle),
        ),
      );
    };

    const loadCurrentBundlesForIndexRebuild = async (): Promise<Bundle[]> => {
      return loadAllBundlesForManagementFallback();
    };

    const findPageIndexContainingId = (
      pages: ManagementIndexPageDescriptor[],
      id: string,
    ): number => {
      return pages.findIndex(
        (page) =>
          id.localeCompare(page.firstId) <= 0 &&
          id.localeCompare(page.lastId) >= 0,
      );
    };

    const readPagedBundles = async ({
      root,
      limit,
      offset,
      cursor,
    }: {
      root: ManagementIndexRoot;
      limit: number;
      offset?: number;
      cursor?: DatabaseBundleCursor;
    }) => {
      if (root.total === 0 || root.pages.length === 0) {
        return createEmptyManagementResult(limit);
      }

      const pageStartOffsets = getPageStartOffsets(root.pages);
      const pageCache = new Map<string, Bundle[] | null>();

      if (offset !== undefined) {
        const normalizedOffset = Math.max(0, offset);

        if (normalizedOffset >= root.total) {
          return {
            data: [] as Bundle[],
            pagination: calculatePagination(root.total, {
              limit,
              offset: normalizedOffset,
            }),
          };
        }

        let pageIndex = 0;
        for (let index = pageStartOffsets.length - 1; index >= 0; index--) {
          if ((pageStartOffsets[index] ?? 0) <= normalizedOffset) {
            pageIndex = index;
            break;
          }
        }
        const startInPage =
          normalizedOffset - (pageStartOffsets[pageIndex] ?? 0);
        const data: Bundle[] = [];

        for (
          let currentPageIndex = pageIndex;
          currentPageIndex < root.pages.length &&
          (limit <= 0 || data.length < limit);
          currentPageIndex++
        ) {
          const descriptor = root.pages[currentPageIndex]!;
          const page = await loadManagementPage(descriptor, pageCache);
          if (!page) {
            return paginateBundles({
              bundles: await loadAllBundlesForManagementFallback(),
              limit,
              offset: normalizedOffset,
            });
          }

          data.push(
            ...(currentPageIndex === pageIndex
              ? page.slice(startInPage)
              : page),
          );
        }

        const paginatedData = limit > 0 ? data.slice(0, limit) : data;
        const pagination = calculatePagination(root.total, {
          limit,
          offset: normalizedOffset,
        });

        return {
          data: paginatedData,
          pagination: {
            ...pagination,
            ...(paginatedData.length > 0 &&
            normalizedOffset + paginatedData.length < root.total
              ? { nextCursor: paginatedData.at(-1)?.id }
              : {}),
            ...(paginatedData.length > 0 && normalizedOffset > 0
              ? { previousCursor: paginatedData[0]?.id }
              : {}),
          },
        };
      }

      if (cursor?.after) {
        let pageIndex = root.pages.findIndex((page) => {
          const containsCursor =
            cursor.after!.localeCompare(page.firstId) <= 0 &&
            cursor.after!.localeCompare(page.lastId) >= 0;
          const wholePageEligible =
            cursor.after!.localeCompare(page.firstId) > 0;
          return containsCursor || wholePageEligible;
        });

        if (pageIndex < 0) {
          return {
            data: [] as Bundle[],
            pagination: {
              ...calculatePagination(root.total, {
                limit,
                offset: root.total,
              }),
              previousCursor: cursor.after,
            },
          };
        }

        const data: Bundle[] = [];
        let startIndex: number | null = null;

        while (
          pageIndex < root.pages.length &&
          (limit <= 0 || data.length < limit)
        ) {
          const descriptor = root.pages[pageIndex]!;
          const page = await loadManagementPage(descriptor, pageCache);
          if (!page) {
            return paginateBundles({
              bundles: await loadAllBundlesForManagementFallback(),
              limit,
              cursor,
            });
          }

          const containsCursor =
            cursor.after.localeCompare(descriptor.firstId) <= 0 &&
            cursor.after.localeCompare(descriptor.lastId) >= 0;
          let eligiblePageBundles = page;

          if (containsCursor) {
            const startInPage = page.findIndex(
              (bundle) => bundle.id.localeCompare(cursor.after!) < 0,
            );
            if (startInPage < 0) {
              eligiblePageBundles = [];
            } else {
              eligiblePageBundles = page.slice(startInPage);
              startIndex ??= (pageStartOffsets[pageIndex] ?? 0) + startInPage;
            }
          } else if (eligiblePageBundles.length > 0) {
            startIndex ??= pageStartOffsets[pageIndex] ?? 0;
          }

          data.push(...eligiblePageBundles);

          if (limit > 0 && data.length >= limit) {
            break;
          }

          pageIndex += 1;
        }

        const paginatedData = limit > 0 ? data.slice(0, limit) : data;
        const resolvedStartIndex = startIndex ?? root.total;
        const pagination = calculatePagination(root.total, {
          limit,
          offset: resolvedStartIndex,
        });

        return {
          data: paginatedData,
          pagination: {
            ...pagination,
            ...(paginatedData.length > 0 &&
            resolvedStartIndex + paginatedData.length < root.total
              ? { nextCursor: paginatedData.at(-1)?.id }
              : {}),
            ...(paginatedData.length > 0 && resolvedStartIndex > 0
              ? { previousCursor: paginatedData[0]?.id }
              : {}),
          },
        };
      }

      if (cursor?.before) {
        let pageIndex = -1;
        for (let index = root.pages.length - 1; index >= 0; index--) {
          const page = root.pages[index]!;
          const containsCursor =
            cursor.before.localeCompare(page.firstId) <= 0 &&
            cursor.before.localeCompare(page.lastId) >= 0;
          const wholePageEligible =
            cursor.before.localeCompare(page.lastId) < 0;
          if (containsCursor || wholePageEligible) {
            pageIndex = index;
            break;
          }
        }

        if (pageIndex < 0) {
          return createEmptyManagementResult(limit);
        }

        let startIndex: number | null = null;
        let collected: Bundle[] = [];

        while (pageIndex >= 0 && (limit <= 0 || collected.length < limit)) {
          const descriptor = root.pages[pageIndex]!;
          const page = await loadManagementPage(descriptor, pageCache);
          if (!page) {
            return paginateBundles({
              bundles: await loadAllBundlesForManagementFallback(),
              limit,
              cursor,
            });
          }

          const containsCursor =
            cursor.before.localeCompare(descriptor.firstId) <= 0 &&
            cursor.before.localeCompare(descriptor.lastId) >= 0;

          const eligiblePageBundles = containsCursor
            ? page.filter(
                (bundle) => bundle.id.localeCompare(cursor.before!) > 0,
              )
            : page;

          collected = [...eligiblePageBundles, ...collected];
          if (eligiblePageBundles.length > 0) {
            startIndex = pageStartOffsets[pageIndex] ?? 0;
          }

          if (limit > 0 && collected.length >= limit) {
            break;
          }

          pageIndex -= 1;
        }

        if (startIndex === null || collected.length === 0) {
          return createEmptyManagementResult(limit);
        }

        let paginatedData = collected;
        if (limit > 0 && collected.length > limit) {
          const dropCount = collected.length - limit;
          paginatedData = collected.slice(dropCount);
          startIndex += dropCount;
        }

        const pagination = calculatePagination(root.total, {
          limit,
          offset: startIndex,
        });

        return {
          data: paginatedData,
          pagination: {
            ...pagination,
            ...(paginatedData.length > 0 &&
            startIndex + paginatedData.length < root.total
              ? { nextCursor: paginatedData.at(-1)?.id }
              : {}),
            ...(paginatedData.length > 0 && startIndex > 0
              ? { previousCursor: paginatedData[0]?.id }
              : {}),
          },
        };
      }

      const pageIndex = 0;
      const startInPage = 0;
      const data: Bundle[] = [];

      for (
        let currentPageIndex = pageIndex;
        currentPageIndex < root.pages.length &&
        (limit <= 0 || data.length < limit);
        currentPageIndex++
      ) {
        const descriptor = root.pages[currentPageIndex]!;
        const page = await loadManagementPage(descriptor, pageCache);
        if (!page) {
          return paginateBundles({
            bundles: await loadAllBundlesForManagementFallback(),
            limit,
            cursor,
          });
        }

        data.push(
          ...(currentPageIndex === pageIndex ? page.slice(startInPage) : page),
        );
      }

      const paginatedData = limit > 0 ? data.slice(0, limit) : data;
      const pagination = calculatePagination(root.total, {
        limit,
        offset: 0,
      });

      return {
        data: paginatedData,
        pagination: {
          ...pagination,
          ...(paginatedData.length > 0 && paginatedData.length < root.total
            ? { nextCursor: paginatedData.at(-1)?.id }
            : {}),
        },
      };
    };

    // Reload all bundle data from S3.
    async function reloadBundles() {
      bundlesMap.clear();

      const updateJsonKeys = (await listObjects("")).filter((key) =>
        /^[^/]+\/(?:ios|android)\/[^/]+\/update\.json$/.test(key),
      );
      const filePromises = updateJsonKeys.map(async (key) => {
        const bundlesData = (await loadObject<Bundle[]>(key)) ?? [];
        return bundlesData.map((bundle) => ({
          ...bundle,
          _updateJsonKey: key,
        }));
      });
      const allBundles = (await Promise.all(filePromises)).flat();

      for (const bundle of allBundles) {
        bundlesMap.set(bundle.id, bundle as BundleWithUpdateJsonKey);
      }

      // Add pending bundles.
      for (const [id, bundle] of pendingBundlesMap.entries()) {
        bundlesMap.set(id, bundle);
      }

      const sortedBundles = orderBy(allBundles, [(v) => v.id], ["desc"]);
      return sortedBundles;
    }

    /**
     * Updates target-app-versions.json for each channel on the given platform.
     * Returns true if the file was updated, false if no changes were made.
     */
    async function updateTargetVersionsForPlatform(
      platform: string,
    ): Promise<void> {
      // Retrieve all update.json files for the platform across channels.
      const updateJsonPattern = new RegExp(
        `^[^/]+/${platform}/[^/]+/update\\.json$`,
      );
      const targetVersionsPattern = new RegExp(
        `^[^/]+/${platform}/target-app-versions\\.json$`,
      );

      const allKeys = await listObjects("");
      const updateJsonKeys = allKeys.filter((key) =>
        updateJsonPattern.test(key),
      );
      const targetVersionsKeys = allKeys.filter((key) =>
        targetVersionsPattern.test(key),
      );

      // Group update.json keys by channel (channel is the first part of the key)
      const keysByChannel = updateJsonKeys.reduce(
        (acc, key) => {
          const parts = key.split("/");
          const channel = parts[0];
          acc[channel] = acc[channel] || [];
          acc[channel].push(key);
          return acc;
        },
        {} as Record<string, string[]>,
      );

      // Also include channels that still have target-app-versions.json
      // even when all update.json files were moved out.
      for (const key of targetVersionsKeys) {
        const channel = key.split("/")[0];
        if (!keysByChannel[channel]) {
          keysByChannel[channel] = [];
        }
      }

      for (const channel of Object.keys(keysByChannel)) {
        const updateKeys = keysByChannel[channel];
        const targetKey = `${channel}/${platform}/target-app-versions.json`;
        // Extract targetAppVersion from each update.json file key.
        const currentVersions = updateKeys.map((key) => key.split("/")[2]);
        const oldTargetVersions = (await loadObject<string[]>(targetKey)) ?? [];
        const newTargetVersions = oldTargetVersions.filter((v) =>
          currentVersions.includes(v),
        );
        for (const v of currentVersions) {
          if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
        }

        if (
          JSON.stringify(oldTargetVersions) !==
          JSON.stringify(newTargetVersions)
        ) {
          await uploadObject(targetKey, newTargetVersions);
        }
      }
    }

    const getAppVersionUpdateInfo = async ({
      appVersion,
      bundleId,
      channel = "production",
      cohort,
      minBundleId,
      platform,
    }: AppVersionGetBundlesArgs): Promise<UpdateInfo | null> => {
      const targetVersionsKey = `${channel}/${platform}/target-app-versions.json`;
      const targetAppVersions =
        (await loadObject<string[]>(targetVersionsKey)) ?? [];
      const matchingVersions = filterCompatibleAppVersions(
        targetAppVersions,
        appVersion,
      );

      const result = await Promise.allSettled(
        matchingVersions.map(async (targetAppVersion) => {
          const normalizedVersion =
            normalizeTargetAppVersion(targetAppVersion) ?? targetAppVersion;

          return (
            (await loadObject<Bundle[]>(
              `${channel}/${platform}/${normalizedVersion}/update.json`,
            )) ?? []
          );
        }),
      );

      const bundles = result
        .filter(
          (entry): entry is PromiseFulfilledResult<Bundle[]> =>
            entry.status === "fulfilled",
        )
        .flatMap((entry) => entry.value);

      return getManifestUpdateInfo(bundles, {
        _updateStrategy: "appVersion",
        appVersion,
        bundleId,
        channel,
        cohort,
        minBundleId,
        platform,
      });
    };

    const getFingerprintUpdateInfo = async ({
      bundleId,
      channel = "production",
      cohort,
      fingerprintHash,
      minBundleId,
      platform,
    }: FingerprintGetBundlesArgs): Promise<UpdateInfo | null> => {
      const bundles =
        (await loadObject<Bundle[]>(
          `${channel}/${platform}/${fingerprintHash}/update.json`,
        )) ?? [];

      return getManifestUpdateInfo(bundles, {
        _updateStrategy: "fingerprint",
        bundleId,
        channel,
        cohort,
        fingerprintHash,
        minBundleId,
        platform,
      });
    };

    const addAppVersionInvalidationPaths = (
      pathsToInvalidate: Set<string>,
      {
        platform,
        channel,
        targetAppVersion,
      }: {
        platform: string;
        channel: string;
        targetAppVersion: string;
      },
    ) => {
      if (!isExactVersion(targetAppVersion)) {
        pathsToInvalidate.add(`${apiBasePath}/app-version/${platform}/*`);
        return;
      }

      const normalizedVersions = getSemverNormalizedVersions(targetAppVersion);
      for (const version of normalizedVersions) {
        pathsToInvalidate.add(
          `${apiBasePath}/app-version/${platform}/${version}/${channel}/*`,
        );
      }
    };

    const addLookupInvalidationPaths = (
      pathsToInvalidate: Set<string>,
      {
        platform,
        channel,
        targetAppVersion,
        fingerprintHash,
      }: {
        platform: string;
        channel: string;
        targetAppVersion?: string | null;
        fingerprintHash?: string | null;
      },
    ) => {
      if (fingerprintHash) {
        pathsToInvalidate.add(
          `${apiBasePath}/fingerprint/${platform}/${fingerprintHash}/${channel}/*`,
        );
        return;
      }

      if (targetAppVersion) {
        addAppVersionInvalidationPaths(pathsToInvalidate, {
          platform,
          channel,
          targetAppVersion,
        });
      }
    };

    return createDatabasePlugin({
      name,
      factory: () => ({
        supportsCursorPagination: true,
        async getBundleById(bundleId: string) {
          const pendingBundle = pendingBundlesMap.get(bundleId);
          if (pendingBundle) {
            return removeBundleInternalKeys(pendingBundle);
          }
          const bundle = bundlesMap.get(bundleId);
          if (bundle) {
            return removeBundleInternalKeys(bundle);
          }

          const allRoot = await loadManagementScopeRoot({});
          if (allRoot) {
            const matchedBundle = await loadBundleFromManagementRoot(
              allRoot,
              bundleId,
            );
            if (matchedBundle) {
              return removeBundleInternalKeys(
                createHydratedBundle(matchedBundle),
              );
            }

            managementRootCache.delete(ALL_SCOPE_CACHE_KEY);
            const refreshedAllRoot = await loadStoredManagementRoot({});
            if (refreshedAllRoot) {
              const refreshedBundle = await loadBundleFromManagementRoot(
                refreshedAllRoot,
                bundleId,
              );
              if (refreshedBundle) {
                return removeBundleInternalKeys(
                  createHydratedBundle(refreshedBundle),
                );
              }
            }
          }

          const bundles = await reloadBundles();
          const matchedBundle = bundles.find((item) => item.id === bundleId);
          if (!matchedBundle) {
            return null;
          }

          return removeBundleInternalKeys(matchedBundle);
        },

        async getUpdateInfo(args: GetBundlesArgs) {
          if (args._updateStrategy === "appVersion") {
            return getAppVersionUpdateInfo(args);
          }

          return getFingerprintUpdateInfo(args);
        },

        async getBundles(options) {
          const { where, limit, offset, orderBy, cursor } = options;
          const scope = getSupportedManagementScope(where, orderBy);

          if (scope) {
            const root = await loadManagementScopeRoot(scope);
            if (!root) {
              return createEmptyManagementResult(limit);
            }

            return readPagedBundles({
              root,
              limit,
              offset,
              cursor,
            });
          }

          let allBundles = await loadAllBundlesForManagementFallback();
          if (where) {
            allBundles = allBundles.filter((bundle) =>
              bundleMatchesQueryWhere(bundle, where),
            );
          }

          return paginateBundles({
            bundles: allBundles,
            limit,
            offset,
            cursor,
            orderBy,
          });
        },

        async getChannels() {
          const allRoot = await loadManagementScopeRoot({});
          return allRoot?.channels ?? [];
        },

        async commitBundle({ changedSets }) {
          if (changedSets.length === 0) return;

          const changedBundlesByKey: Record<string, Bundle[]> = {};
          const removalsByKey: Record<string, string[]> = {};
          const pathsToInvalidate: Set<string> = new Set();

          let isTargetAppVersionChanged = false;
          let isChannelChanged = false;

          for (const { operation, data } of changedSets) {
            if (data.targetAppVersion !== undefined) {
              isTargetAppVersionChanged = true;
            }
            if (operation === "update" && data.channel !== undefined) {
              isChannelChanged = true;
            }

            // Insert operation.
            if (operation === "insert") {
              const target = resolveStorageTarget(data);
              const key = `${data.channel}/${data.platform}/${target}/update.json`;
              const bundleWithKey: BundleWithUpdateJsonKey = {
                ...data,
                _updateJsonKey: key,
              };

              bundlesMap.set(data.id, bundleWithKey);
              pendingBundlesMap.set(data.id, bundleWithKey);

              changedBundlesByKey[key] = changedBundlesByKey[key] || [];
              changedBundlesByKey[key].push(
                removeBundleInternalKeys(bundleWithKey),
              );

              addLookupInvalidationPaths(pathsToInvalidate, data);
              continue;
            }

            // Delete operation.
            if (operation === "delete") {
              let bundle = pendingBundlesMap.get(data.id);
              if (!bundle) {
                bundle = bundlesMap.get(data.id);
              }
              if (!bundle) {
                throw new Error("Bundle to delete not found");
              }

              // Remove from memory maps
              bundlesMap.delete(data.id);
              pendingBundlesMap.delete(data.id);

              // Mark for removal from update.json
              const key = bundle._updateJsonKey;
              removalsByKey[key] = removalsByKey[key] || [];
              removalsByKey[key].push(bundle.id);

              addLookupInvalidationPaths(pathsToInvalidate, bundle);
              continue;
            }

            // For update operations, retrieve the current bundle.
            let bundle = pendingBundlesMap.get(data.id);
            if (!bundle) {
              bundle = bundlesMap.get(data.id);
            }
            if (!bundle) {
              throw new Error("targetBundleId not found");
            }

            if (operation === "update") {
              const updatedBundle = { ...bundle, ...data };
              const newKey = `${updatedBundle.channel}/${updatedBundle.platform}/${resolveStorageTarget(updatedBundle)}/update.json`;

              if (newKey !== bundle._updateJsonKey) {
                // If the key has changed (e.g., channel or targetAppVersion update), remove from old location.
                const oldKey = bundle._updateJsonKey;
                removalsByKey[oldKey] = removalsByKey[oldKey] || [];
                removalsByKey[oldKey].push(bundle.id);

                changedBundlesByKey[newKey] = changedBundlesByKey[newKey] || [];

                updatedBundle._oldUpdateJsonKey = oldKey;
                updatedBundle._updateJsonKey = newKey;

                bundlesMap.set(data.id, updatedBundle);
                pendingBundlesMap.set(data.id, updatedBundle);

                changedBundlesByKey[newKey].push(
                  removeBundleInternalKeys(updatedBundle),
                );

                const oldChannel = bundle.channel;
                const nextChannel = updatedBundle.channel;
                if (oldChannel !== nextChannel) {
                  addLookupInvalidationPaths(pathsToInvalidate, bundle);
                  if (bundle.targetAppVersion && !bundle.fingerprintHash) {
                    addLookupInvalidationPaths(pathsToInvalidate, {
                      ...bundle,
                      channel: nextChannel,
                    });
                  }
                }

                addLookupInvalidationPaths(pathsToInvalidate, updatedBundle);
                if (
                  bundle.targetAppVersion &&
                  bundle.targetAppVersion !== updatedBundle.targetAppVersion
                ) {
                  addLookupInvalidationPaths(pathsToInvalidate, bundle);
                }
                continue;
              }

              // No key change: update the bundle normally.
              const currentKey = bundle._updateJsonKey;
              bundlesMap.set(data.id, updatedBundle);
              pendingBundlesMap.set(data.id, updatedBundle);
              changedBundlesByKey[currentKey] =
                changedBundlesByKey[currentKey] || [];
              changedBundlesByKey[currentKey].push(
                removeBundleInternalKeys(updatedBundle),
              );

              addLookupInvalidationPaths(pathsToInvalidate, updatedBundle);
              if (
                bundle.targetAppVersion &&
                bundle.targetAppVersion !== updatedBundle.targetAppVersion
              ) {
                addLookupInvalidationPaths(pathsToInvalidate, bundle);
              }
            }
          }

          // Remove bundles from their old keys.
          for (const oldKey of Object.keys(removalsByKey)) {
            await (async () => {
              const currentBundles = (await loadObject<Bundle[]>(oldKey)) ?? [];
              const updatedBundles = currentBundles.filter(
                (b) => !removalsByKey[oldKey].includes(b.id),
              );
              updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
              if (updatedBundles.length === 0) {
                await deleteObject(oldKey);
              } else {
                await uploadObject(oldKey, updatedBundles);
              }
            })();
          }

          // Add or update bundles in their new keys.
          for (const key of Object.keys(changedBundlesByKey)) {
            await (async () => {
              const currentBundles = (await loadObject<Bundle[]>(key)) ?? [];
              const pureBundles = changedBundlesByKey[key].map(
                (bundle) => bundle,
              );
              for (const changedBundle of pureBundles) {
                const index = currentBundles.findIndex(
                  (b) => b.id === changedBundle.id,
                );
                if (index >= 0) {
                  currentBundles[index] = changedBundle;
                } else {
                  currentBundles.push(changedBundle);
                }
              }
              currentBundles.sort((a, b) => b.id.localeCompare(a.id));
              await uploadObject(key, currentBundles);
            })();
          }

          if (isTargetAppVersionChanged || isChannelChanged) {
            for (const platform of PLATFORMS) {
              await updateTargetVersionsForPlatform(platform);
            }
          }

          const currentIndexBundles = await loadCurrentBundlesForIndexRebuild();
          const nextIndexMap = new Map(
            currentIndexBundles.map((bundle) => [bundle.id, bundle]),
          );
          for (const { operation, data } of changedSets) {
            if (operation === "delete") {
              nextIndexMap.delete(data.id);
              continue;
            }

            nextIndexMap.set(data.id, data);
          }

          const nextIndexBundles = sortManagedBundles(
            Array.from(nextIndexMap.values()),
          );
          const previousArtifacts = buildManagementIndexArtifacts(
            currentIndexBundles,
            managementIndexPageSize,
          );
          const nextArtifacts = buildManagementIndexArtifacts(
            nextIndexBundles,
            managementIndexPageSize,
          );
          await persistManagementIndexArtifacts(
            nextArtifacts,
            previousArtifacts,
          );
          replaceManagementRootCache(nextArtifacts);

          // Enconded paths for invalidation (in case of special characters)
          const encondedPaths = new Set<string>();
          for (const path of pathsToInvalidate) {
            encondedPaths.add(encodeURI(path));
          }

          await invalidatePaths(Array.from(encondedPaths));

          pendingBundlesMap.clear();
        },
      }),
    })({}, hooks);
  };
};

import { orderBy } from "es-toolkit";
import semver from "semver";

import { createDatabasePlugin } from "./createDatabasePlugin";
import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";
import { paginateBundles } from "./paginateBundles";
import { bundleMatchesQueryWhere, sortBundles } from "./queryBundles";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  AppVersionGetBundlesArgs,
  Bundle,
  DatabaseBundleQueryWhere,
  DatabaseBundleQueryOrder,
  DatabasePluginHooks,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  HotUpdaterContext,
  UpdateInfo,
} from "./types";

interface BundleWithUpdateJsonKey extends Bundle {
  _updateJsonKey: string;
  _oldUpdateJsonKey?: string;
}

type TargetVersionMutation = {
  readonly channel: string;
  readonly platform: string;
  readonly additions: Set<string>;
  readonly removals: Set<string>;
};

const STORAGE_OPERATION_CONCURRENCY = 8;

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= items.length) {
          break;
        }

        results[index] = await mapper(items[index]!, index);
      }
    }),
  );

  return results;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, concurrency, mapper);
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

function targetVersionMutationKey(
  bundle: Pick<Bundle, "channel" | "platform">,
): string {
  return `${bundle.channel}/${bundle.platform}`;
}

function getTargetVersionMutation(
  mutations: Map<string, TargetVersionMutation>,
  bundle: Pick<Bundle, "channel" | "platform">,
): TargetVersionMutation {
  const key = targetVersionMutationKey(bundle);
  const existingMutation = mutations.get(key);
  if (existingMutation) {
    return existingMutation;
  }

  const mutation: TargetVersionMutation = {
    additions: new Set(),
    channel: bundle.channel,
    platform: bundle.platform,
    removals: new Set(),
  };
  mutations.set(key, mutation);
  return mutation;
}

function addTargetVersionAddition(
  mutations: Map<string, TargetVersionMutation>,
  bundle: Pick<Bundle, "channel" | "platform" | "targetAppVersion">,
): void {
  const targetAppVersion = normalizeTargetAppVersion(bundle.targetAppVersion);
  if (targetAppVersion == null) {
    return;
  }

  getTargetVersionMutation(mutations, bundle).additions.add(targetAppVersion);
}

function addTargetVersionRemoval(
  mutations: Map<string, TargetVersionMutation>,
  bundle: Pick<Bundle, "channel" | "platform" | "targetAppVersion">,
): void {
  const targetAppVersion = normalizeTargetAppVersion(bundle.targetAppVersion);
  if (targetAppVersion == null) {
    return;
  }

  getTargetVersionMutation(mutations, bundle).removals.add(targetAppVersion);
}

function getManagementListPrefixes(
  where: DatabaseBundleQueryWhere | undefined,
): string[] {
  if (where?.channel && where.platform) {
    return [`${where.channel}/${where.platform}/`];
  }

  if (where?.channel) {
    return [`${where.channel}/`];
  }

  return [""];
}

const DEFAULT_DESC_ORDER = { field: "id", direction: "desc" } as const;

function sortManagedBundles(
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder = DEFAULT_DESC_ORDER,
): Bundle[] {
  return sortBundles(bundles, orderBy);
}

export interface BlobOperations {
  listObjects: (prefix: string) => Promise<string[]>;
  loadObject: <T>(key: string) => Promise<T | null>;
  uploadObject: <T>(key: string, data: T) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
  shouldSkipLoadObjectError?: (error: unknown, key: string) => boolean;
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
    const {
      listObjects,
      loadObject,
      uploadObject,
      deleteObject,
      shouldSkipLoadObjectError,
      invalidatePaths,
      apiBasePath,
    } = factory(config);
    // Map for O(1) lookup of bundles.
    const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
    // Temporary store for newly added or modified bundles.
    const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();
    const locallyDeletedBundleIds = new Set<string>();

    const loadOptionalObject = async <T>(key: string): Promise<T | null> => {
      try {
        return await loadObject<T>(key);
      } catch (error) {
        if (shouldSkipLoadObjectError?.(error, key)) {
          return null;
        }
        throw error;
      }
    };

    const loadAllBundlesForManagementFallback = async (
      where?: DatabaseBundleQueryWhere,
    ): Promise<Bundle[]> => {
      return sortManagedBundles(
        (await reloadBundles(getManagementListPrefixes(where))).map((bundle) =>
          removeBundleInternalKeys(bundle),
        ),
      );
    };

    const cacheBundlesFromObject = (key: string, bundles: Bundle[]) => {
      for (const bundle of bundles) {
        if (
          locallyDeletedBundleIds.has(bundle.id) ||
          pendingBundlesMap.has(bundle.id)
        ) {
          continue;
        }

        bundlesMap.set(bundle.id, {
          ...bundle,
          _updateJsonKey: key,
        });
      }
    };

    const loadBundleObject = async (key: string): Promise<Bundle[]> => {
      const bundles = (await loadOptionalObject<Bundle[]>(key)) ?? [];
      cacheBundlesFromObject(key, bundles);
      return bundles;
    };

    // Reload all bundle data from S3.
    async function reloadBundles(prefixes: readonly string[] = [""]) {
      bundlesMap.clear();
      pendingBundlesMap.clear();
      locallyDeletedBundleIds.clear();

      const updateJsonKeys = (
        await mapWithConcurrency(
          prefixes,
          STORAGE_OPERATION_CONCURRENCY,
          (prefix) => listObjects(prefix),
        )
      )
        .flat()
        .filter((key) =>
          /^[^/]+\/(?:ios|android)\/[^/]+\/update\.json$/.test(key),
        );
      const allBundles = (
        await mapWithConcurrency(
          updateJsonKeys,
          STORAGE_OPERATION_CONCURRENCY,
          async (key) => {
            const bundlesData = await loadBundleObject(key);
            return bundlesData.map((bundle) => ({
              ...bundle,
              _updateJsonKey: key,
            }));
          },
        )
      ).flat();

      for (const bundle of allBundles) {
        bundlesMap.set(bundle.id, bundle as BundleWithUpdateJsonKey);
      }

      // Add pending bundles.
      for (const [id, bundle] of pendingBundlesMap.entries()) {
        bundlesMap.set(id, bundle);
      }

      const sortedBundles = orderBy(
        Array.from(bundlesMap.values()),
        [(v) => v.id],
        ["desc"],
      );
      return sortedBundles;
    }

    async function applyTargetVersionMutations(
      mutations: ReadonlyMap<string, TargetVersionMutation>,
    ): Promise<void> {
      await Promise.all(
        Array.from(mutations.values()).map(
          async ({ additions, channel, platform, removals }) => {
            const targetKey = `${channel}/${platform}/target-app-versions.json`;
            const oldTargetVersions =
              (await loadOptionalObject<string[]>(targetKey)) ?? [];
            const newTargetVersions = oldTargetVersions.filter(
              (version) => !removals.has(version) || additions.has(version),
            );

            for (const version of additions) {
              if (!newTargetVersions.includes(version)) {
                newTargetVersions.push(version);
              }
            }

            if (
              JSON.stringify(oldTargetVersions) !==
              JSON.stringify(newTargetVersions)
            ) {
              await uploadObject(targetKey, newTargetVersions);
            }
          },
        ),
      );
    }

    const getAppVersionUpdateInfo = async (
      {
        appVersion,
        bundleId,
        channel = "production",
        cohort,
        minBundleId,
        platform,
      }: AppVersionGetBundlesArgs,
      context?: HotUpdaterContext,
    ): Promise<UpdateInfo | null> => {
      const targetVersionsKey = `${channel}/${platform}/target-app-versions.json`;
      const targetAppVersions =
        (await loadOptionalObject<string[]>(targetVersionsKey)) ?? [];
      const matchingVersions = filterCompatibleAppVersions(
        targetAppVersions,
        appVersion,
      );

      const bundles = (
        await mapWithConcurrency(
          matchingVersions,
          STORAGE_OPERATION_CONCURRENCY,
          async (targetAppVersion) => {
            const normalizedVersion =
              normalizeTargetAppVersion(targetAppVersion) ?? targetAppVersion;

            return loadBundleObject(
              `${channel}/${platform}/${normalizedVersion}/update.json`,
            );
          },
        )
      ).flat();

      return resolveUpdateInfoFromBundles({
        args: {
          _updateStrategy: "appVersion",
          appVersion,
          bundleId,
          channel,
          cohort,
          minBundleId,
          platform,
        },
        bundles,
        context,
      });
    };

    const getFingerprintUpdateInfo = async (
      {
        bundleId,
        channel = "production",
        cohort,
        fingerprintHash,
        minBundleId,
        platform,
      }: FingerprintGetBundlesArgs,
      context?: HotUpdaterContext,
    ): Promise<UpdateInfo | null> => {
      const bundles = await loadBundleObject(
        `${channel}/${platform}/${fingerprintHash}/update.json`,
      );

      return resolveUpdateInfoFromBundles({
        args: {
          _updateStrategy: "fingerprint",
          bundleId,
          channel,
          cohort,
          fingerprintHash,
          minBundleId,
          platform,
        },
        bundles,
        context,
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

    const createPlugin = createDatabasePlugin({
      name,
      factory: () => ({
        bundles: {
          supportsCursorPagination: true,
          async getBundleById(bundleId: string) {
            if (locallyDeletedBundleIds.has(bundleId)) {
              return null;
            }

            const pendingBundle = pendingBundlesMap.get(bundleId);
            if (pendingBundle) {
              return removeBundleInternalKeys(pendingBundle);
            }
            const bundle = bundlesMap.get(bundleId);
            if (bundle) {
              return removeBundleInternalKeys(bundle);
            }

            const bundles = await reloadBundles();
            const matchedBundle = bundles.find((item) => item.id === bundleId);
            if (!matchedBundle) {
              return null;
            }

            return removeBundleInternalKeys(matchedBundle);
          },

          async getUpdateInfo(
            args: GetBundlesArgs,
            context?: HotUpdaterContext,
          ) {
            if (args._updateStrategy === "appVersion") {
              return getAppVersionUpdateInfo(args, context);
            }

            return getFingerprintUpdateInfo(args, context);
          },

          async getBundles(options) {
            const { where, limit, offset, orderBy, cursor } = options;
            let allBundles = await loadAllBundlesForManagementFallback(where);
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
        },

        async commit({ changedSets }) {
            if (changedSets.length === 0) return;

            const changedBundlesByKey: Record<string, Bundle[]> = {};
            const removalsByKey: Record<string, string[]> = {};
            const targetVersionRemovalsByKey: Record<
              string,
              BundleWithUpdateJsonKey[]
            > = {};
            const pathsToInvalidate: Set<string> = new Set();
            const targetVersionMutations = new Map<
              string,
              TargetVersionMutation
            >();

            for (const { operation, data } of changedSets) {
              // Insert operation.
              if (operation === "insert") {
                const target = resolveStorageTarget(data);
                const key = `${data.channel}/${data.platform}/${target}/update.json`;
                const bundleWithKey: BundleWithUpdateJsonKey = {
                  ...data,
                  _updateJsonKey: key,
                };

                locallyDeletedBundleIds.delete(data.id);
                bundlesMap.set(data.id, bundleWithKey);
                pendingBundlesMap.set(data.id, bundleWithKey);

                changedBundlesByKey[key] = changedBundlesByKey[key] || [];
                changedBundlesByKey[key].push(
                  removeBundleInternalKeys(bundleWithKey),
                );

                addTargetVersionAddition(targetVersionMutations, data);
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
                locallyDeletedBundleIds.add(data.id);

                // Mark for removal from update.json
                const key = bundle._updateJsonKey;
                removalsByKey[key] = removalsByKey[key] || [];
                removalsByKey[key].push(bundle.id);
                targetVersionRemovalsByKey[key] =
                  targetVersionRemovalsByKey[key] || [];
                targetVersionRemovalsByKey[key].push(bundle);

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
                  targetVersionRemovalsByKey[oldKey] =
                    targetVersionRemovalsByKey[oldKey] || [];
                  targetVersionRemovalsByKey[oldKey].push(bundle);

                  changedBundlesByKey[newKey] =
                    changedBundlesByKey[newKey] || [];

                  updatedBundle._oldUpdateJsonKey = oldKey;
                  updatedBundle._updateJsonKey = newKey;

                  bundlesMap.set(data.id, updatedBundle);
                  pendingBundlesMap.set(data.id, updatedBundle);
                  locallyDeletedBundleIds.delete(data.id);

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

                  addTargetVersionAddition(
                    targetVersionMutations,
                    updatedBundle,
                  );
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
                locallyDeletedBundleIds.delete(data.id);
                changedBundlesByKey[currentKey] =
                  changedBundlesByKey[currentKey] || [];
                changedBundlesByKey[currentKey].push(
                  removeBundleInternalKeys(updatedBundle),
                );

                addLookupInvalidationPaths(pathsToInvalidate, updatedBundle);
                addTargetVersionAddition(targetVersionMutations, updatedBundle);
                if (
                  bundle.targetAppVersion &&
                  bundle.targetAppVersion !== updatedBundle.targetAppVersion
                ) {
                  addLookupInvalidationPaths(pathsToInvalidate, bundle);
                }
              }
            }

            // Remove bundles from their old keys.
            await forEachWithConcurrency(
              Object.keys(removalsByKey),
              STORAGE_OPERATION_CONCURRENCY,
              async (oldKey) => {
                const currentBundles =
                  (await loadOptionalObject<Bundle[]>(oldKey)) ?? [];
                const updatedBundles = currentBundles.filter(
                  (b) => !removalsByKey[oldKey].includes(b.id),
                );
                updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
                if (updatedBundles.length === 0) {
                  await deleteObject(oldKey);
                  for (const removedBundle of targetVersionRemovalsByKey[
                    oldKey
                  ] ?? []) {
                    addTargetVersionRemoval(
                      targetVersionMutations,
                      removedBundle,
                    );
                  }
                } else {
                  await uploadObject(oldKey, updatedBundles);
                }
              },
            );

            // Add or update bundles in their new keys.
            await forEachWithConcurrency(
              Object.keys(changedBundlesByKey),
              STORAGE_OPERATION_CONCURRENCY,
              async (key) => {
                const currentBundles =
                  (await loadOptionalObject<Bundle[]>(key)) ?? [];
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
              },
            );

            if (targetVersionMutations.size > 0) {
              await applyTargetVersionMutations(targetVersionMutations);
            }

            // Enconded paths for invalidation (in case of special characters)
            const encondedPaths = new Set<string>();
            for (const path of pathsToInvalidate) {
              encondedPaths.add(encodeURI(path));
            }

            await invalidatePaths(Array.from(encondedPaths));

            pendingBundlesMap.clear();
          },
        channels: {
          async getChannels() {
            return [
              ...new Set(
                (await loadAllBundlesForManagementFallback()).map(
                  (bundle) => bundle.channel,
                ),
              ),
            ].sort();
          },
        },
      }),
    })({}, hooks);

    return () => {
      const plugin = createPlugin();

      return plugin;
    };
  };
};

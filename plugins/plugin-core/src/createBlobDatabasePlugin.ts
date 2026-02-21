import { orderBy } from "es-toolkit";
import semver from "semver";
import { calculatePagination } from "./calculatePagination";
import { createDatabasePlugin } from "./createDatabasePlugin";
import type { Bundle, DatabasePluginHooks } from "./types";

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

    const PLATFORMS = ["ios", "android"] as const;

    // Reload bundle data from blob storage.
    async function reloadBundles(where?: { platform?: string; channel?: string }) {
      bundlesMap.clear();

      const keys = await listUpdateJsonKeys(where?.platform, where?.channel);
      const filePromises = keys.map(async (key) => {
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

      return orderBy(allBundles, [(v) => v.id], ["desc"]);
    }

    /**
     * Updates target-app-versions.json for each channel on the given platform.
     * Returns true if the file was updated, false if no changes were made.
     */
    async function updateTargetVersionsForPlatform(
      platform: string,
    ): Promise<Set<string>> {
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

      const updatedTargetFiles = new Set<string>();

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
          updatedTargetFiles.add(`/${targetKey}`);
        }
      }

      return updatedTargetFiles;
    }

    /**
     * Lists update.json keys for a given platform.
     *
     * - If a channel is provided, only that channel's update.json files are listed.
     * - Otherwise, all channels for the given platform are returned.
     */
    async function listUpdateJsonKeys(
      platform?: string,
      channel?: string,
    ): Promise<string[]> {
      const prefix = channel
        ? platform
          ? `${channel}/${platform}/`
          : `${channel}/`
        : "";
      // Use appropriate key format based on whether a channel is given.
      const pattern = channel
        ? platform
          ? new RegExp(`^${channel}/${platform}/[^/]+/update\\.json$`)
          : new RegExp(`^${channel}/[^/]+/[^/]+/update\\.json$`)
        : platform
          ? new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`)
          : /^[^/]+\/[^/]+\/[^/]+\/update\.json$/;

      return listObjects(prefix).then((keys) =>
        keys.filter((key) => pattern.test(key)),
      );
    }

    return createDatabasePlugin({
      name,
      factory: () => ({
        async getBundleById(bundleId: string) {
          const pendingBundle = pendingBundlesMap.get(bundleId);
          if (pendingBundle) {
            return removeBundleInternalKeys(pendingBundle);
          }
          const bundle = bundlesMap.get(bundleId);
          if (bundle) {
            return removeBundleInternalKeys(bundle);
          }
          const bundles = await reloadBundles();
          return bundles.find((bundle) => bundle.id === bundleId) ?? null;
        },

        async getBundles(options) {
          const { where, limit, offset } = options;
          const normalizedWhere = {
            channel: where?.channel ?? undefined,
            platform: where?.platform ?? undefined,
          };
          // Always load the latest data from S3.
          let allBundles = await reloadBundles(normalizedWhere);

          // Apply filtering conditions first to get the total count after filtering
          if (where) {
            allBundles = allBundles.filter((bundle) => {
              return Object.entries(where).every(
                ([key, value]) =>
                  value === undefined ||
                  value === null ||
                  bundle[key as keyof Bundle] === value,
              );
            });
          }

          const total = allBundles.length;
          const cleanBundles = allBundles.map(removeBundleInternalKeys);

          // Apply pagination to data
          let paginatedData = cleanBundles;
          if (offset > 0) {
            paginatedData = paginatedData.slice(offset);
          }
          if (limit) {
            paginatedData = paginatedData.slice(0, limit);
          }

          return {
            data: paginatedData,
            pagination: calculatePagination(total, {
              limit,
              offset,
            }),
          };
        },

        async getChannels() {
          const keys = await listUpdateJsonKeys();
          return [...new Set(keys.map((key) => key.split("/")[0]))];
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
              const target =
                normalizeTargetAppVersion(data.targetAppVersion) ??
                data.fingerprintHash;
              if (!target) {
                throw new Error("target not found");
              }
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

              pathsToInvalidate.add(`/${key}`);
              if (data.fingerprintHash) {
                pathsToInvalidate.add(
                  `${apiBasePath}/fingerprint/${data.platform}/${data.fingerprintHash}/${data.channel}/*`,
                );
              } else if (data.targetAppVersion) {
                if (!isExactVersion(data.targetAppVersion)) {
                  pathsToInvalidate.add(
                    `${apiBasePath}/app-version/${data.platform}/*`,
                  );
                } else {
                  // Invalidate all normalized semver paths
                  const normalizedVersions = getSemverNormalizedVersions(
                    data.targetAppVersion,
                  );
                  for (const version of normalizedVersions) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/app-version/${data.platform}/${version}/${data.channel}/*`,
                    );
                  }
                }
              }
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

              // Add paths for CloudFront invalidation
              pathsToInvalidate.add(`/${key}`);
              if (bundle.fingerprintHash) {
                pathsToInvalidate.add(
                  `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/${bundle.channel}/*`,
                );
              } else if (bundle.targetAppVersion) {
                if (!isExactVersion(bundle.targetAppVersion)) {
                  pathsToInvalidate.add(
                    `${apiBasePath}/app-version/${bundle.platform}/*`,
                  );
                } else {
                  // Invalidate all normalized semver paths
                  const normalizedVersions = getSemverNormalizedVersions(
                    bundle.targetAppVersion,
                  );
                  for (const version of normalizedVersions) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/app-version/${bundle.platform}/${version}/${bundle.channel}/*`,
                    );
                  }
                }
              }
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
              // Compute the new key using updated channel, platform, and targetAppVersion if provided.
              const newChannel =
                data.channel !== undefined ? data.channel : bundle.channel;
              const newPlatform =
                data.platform !== undefined ? data.platform : bundle.platform;
              const target =
                data.fingerprintHash ??
                bundle.fingerprintHash ??
                normalizeTargetAppVersion(data.targetAppVersion) ??
                normalizeTargetAppVersion(bundle.targetAppVersion);
              if (!target) {
                throw new Error("target not found");
              }

              const newKey = `${newChannel}/${newPlatform}/${target}/update.json`;

              if (newKey !== bundle._updateJsonKey) {
                // If the key has changed (e.g., channel or targetAppVersion update), remove from old location.
                const oldKey = bundle._updateJsonKey;
                removalsByKey[oldKey] = removalsByKey[oldKey] || [];
                removalsByKey[oldKey].push(bundle.id);

                changedBundlesByKey[newKey] = changedBundlesByKey[newKey] || [];

                const updatedBundle = { ...bundle, ...data };
                updatedBundle._oldUpdateJsonKey = oldKey;
                updatedBundle._updateJsonKey = newKey;

                bundlesMap.set(data.id, updatedBundle);
                pendingBundlesMap.set(data.id, updatedBundle);

                changedBundlesByKey[newKey].push(
                  removeBundleInternalKeys(updatedBundle),
                );

                // Add paths for CloudFront invalidation
                pathsToInvalidate.add(`/${oldKey}`);
                pathsToInvalidate.add(`/${newKey}`);

                // Add paths for old and new channel target-app-versions.json
                const oldChannel = bundle.channel;
                const newChannel = data.channel;
                if (oldChannel !== newChannel) {
                  pathsToInvalidate.add(
                    `/${oldChannel}/${bundle.platform}/target-app-versions.json`,
                  );
                  pathsToInvalidate.add(
                    `/${newChannel}/${bundle.platform}/target-app-versions.json`,
                  );

                  // Invalidate fingerprint paths for both old and new channels
                  if (bundle.fingerprintHash) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/${oldChannel}/*`,
                    );
                    pathsToInvalidate.add(
                      `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/${newChannel}/*`,
                    );
                  }

                  // Invalidate app-version paths for both old and new channels
                  if (bundle.targetAppVersion) {
                    if (!isExactVersion(bundle.targetAppVersion)) {
                      pathsToInvalidate.add(
                        `${apiBasePath}/app-version/${bundle.platform}/*`,
                      );
                    } else {
                      // Invalidate all normalized semver paths for both channels
                      const normalizedVersions = getSemverNormalizedVersions(
                        bundle.targetAppVersion,
                      );
                      for (const version of normalizedVersions) {
                        pathsToInvalidate.add(
                          `${apiBasePath}/app-version/${bundle.platform}/${version}/${oldChannel}/*`,
                        );
                        pathsToInvalidate.add(
                          `${apiBasePath}/app-version/${bundle.platform}/${version}/${newChannel}/*`,
                        );
                      }
                    }
                  }
                }

                if (updatedBundle.fingerprintHash) {
                  pathsToInvalidate.add(
                    `${apiBasePath}/fingerprint/${bundle.platform}/${updatedBundle.fingerprintHash}/${updatedBundle.channel}/*`,
                  );
                } else if (updatedBundle.targetAppVersion) {
                  // Invalidate based on new targetAppVersion
                  if (!isExactVersion(updatedBundle.targetAppVersion)) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/app-version/${updatedBundle.platform}/*`,
                    );
                  } else {
                    // Invalidate all normalized semver paths for new version
                    const normalizedVersions = getSemverNormalizedVersions(
                      updatedBundle.targetAppVersion,
                    );
                    for (const version of normalizedVersions) {
                      pathsToInvalidate.add(
                        `${apiBasePath}/app-version/${updatedBundle.platform}/${version}/${updatedBundle.channel}/*`,
                      );
                    }
                  }

                  // Also invalidate old targetAppVersion path if it changed
                  if (
                    bundle.targetAppVersion &&
                    bundle.targetAppVersion !== updatedBundle.targetAppVersion
                  ) {
                    if (!isExactVersion(bundle.targetAppVersion)) {
                      pathsToInvalidate.add(
                        `${apiBasePath}/app-version/${bundle.platform}/*`,
                      );
                    } else {
                      // Invalidate all normalized semver paths for old version
                      const oldNormalizedVersions = getSemverNormalizedVersions(
                        bundle.targetAppVersion,
                      );
                      for (const version of oldNormalizedVersions) {
                        pathsToInvalidate.add(
                          `${apiBasePath}/app-version/${bundle.platform}/${version}/${bundle.channel}/*`,
                        );
                      }
                    }
                  }
                }
                continue;
              }

              // No key change: update the bundle normally.
              const currentKey = bundle._updateJsonKey;
              const updatedBundle = { ...bundle, ...data };
              bundlesMap.set(data.id, updatedBundle);
              pendingBundlesMap.set(data.id, updatedBundle);
              changedBundlesByKey[currentKey] =
                changedBundlesByKey[currentKey] || [];
              changedBundlesByKey[currentKey].push(
                removeBundleInternalKeys(updatedBundle),
              );

              pathsToInvalidate.add(`/${currentKey}`);
              if (updatedBundle.fingerprintHash) {
                pathsToInvalidate.add(
                  `${apiBasePath}/fingerprint/${updatedBundle.platform}/${updatedBundle.fingerprintHash}/${updatedBundle.channel}/*`,
                );
              } else if (updatedBundle.targetAppVersion) {
                // Invalidate based on new targetAppVersion
                if (!isExactVersion(updatedBundle.targetAppVersion)) {
                  pathsToInvalidate.add(
                    `${apiBasePath}/app-version/${updatedBundle.platform}/*`,
                  );
                } else {
                  // Invalidate all normalized semver paths for new version
                  const normalizedVersions = getSemverNormalizedVersions(
                    updatedBundle.targetAppVersion,
                  );
                  for (const version of normalizedVersions) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/app-version/${updatedBundle.platform}/${version}/${updatedBundle.channel}/*`,
                    );
                  }
                }

                // Also invalidate old targetAppVersion path if it changed
                if (
                  bundle.targetAppVersion &&
                  bundle.targetAppVersion !== updatedBundle.targetAppVersion
                ) {
                  if (!isExactVersion(bundle.targetAppVersion)) {
                    pathsToInvalidate.add(
                      `${apiBasePath}/app-version/${bundle.platform}/*`,
                    );
                  } else {
                    // Invalidate all normalized semver paths for old version
                    const oldNormalizedVersions = getSemverNormalizedVersions(
                      bundle.targetAppVersion,
                    );
                    for (const version of oldNormalizedVersions) {
                      pathsToInvalidate.add(
                        `${apiBasePath}/app-version/${bundle.platform}/${version}/${bundle.channel}/*`,
                      );
                    }
                  }
                }
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

          // Update target-app-versions.json for each platform and collect paths that were actually updated
          const updatedTargetFilePaths = new Set<string>();
          if (isTargetAppVersionChanged || isChannelChanged) {
            for (const platform of PLATFORMS) {
              const updatedPaths =
                await updateTargetVersionsForPlatform(platform);
              for (const path of updatedPaths) {
                updatedTargetFilePaths.add(path);
              }
            }
          }

          // Add updated target-app-versions.json paths to invalidation list
          for (const path of updatedTargetFilePaths) {
            pathsToInvalidate.add(path);
          }

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

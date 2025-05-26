import { orderBy } from "es-toolkit";
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

/**
 *
 * @param name - The name of the database plugin
 * @param listObjects - Function to list objects in the storage
 * @param loadObject - Function to load an JSON object from the storage
 * @param uploadObject - Function to upload an JSON object to the storage
 * @param deleteObject  - Function to delete an object from the storage
 * @param invalidatePaths - Function to invalidate paths in the CDN
 * @param hooks - Optional hooks for additional functionality - see createDatabasePlugin
 * @returns
 */
export const createBlobDatabasePlugin = <TContext = object>({
  name,
  getContext,
  listObjects,
  loadObject,
  uploadObject,
  deleteObject,
  invalidatePaths,
  hooks,
  apiBasePath,
}: {
  name: string;
  getContext: () => TContext;
  listObjects: (context: TContext, prefix: string) => Promise<string[]>;
  loadObject: <T>(context: TContext, key: string) => Promise<T | null>;
  uploadObject: <T>(context: TContext, key: string, data: T) => Promise<void>;
  deleteObject: (context: TContext, key: string) => Promise<void>;
  invalidatePaths: (context: TContext, paths: string[]) => Promise<void>;
  hooks?: DatabasePluginHooks;
  apiBasePath: string;
}) => {
  // Map for O(1) lookup of bundles.
  const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
  // Temporary store for newly added or modified bundles.
  const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();

  const PLATFORMS = ["ios", "android"] as const;

  // Reload all bundle data from S3.
  async function reloadBundles(context: TContext) {
    bundlesMap.clear();

    const platformPromises = PLATFORMS.map(async (platform) => {
      // Retrieve update.json files for the platform across all channels.
      const keys = await listUpdateJsonKeys(context, platform);
      const filePromises = keys.map(async (key) => {
        const bundlesData = (await loadObject<Bundle[]>(context, key)) ?? [];
        return bundlesData.map((bundle) => ({
          ...bundle,
          _updateJsonKey: key,
        }));
      });
      const results = await Promise.all(filePromises);
      return results.flat();
    });

    const allBundles = (await Promise.all(platformPromises)).flat();

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
    context: TContext,
    platform: string,
  ): Promise<Set<string>> {
    // Retrieve all update.json files for the platform across channels.
    const pattern = new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`);

    const keys = (await listObjects(context, "")).filter((key) =>
      pattern.test(key),
    );

    // Group keys by channel (channel is the first part of the key)
    const keysByChannel = keys.reduce(
      (acc, key) => {
        const parts = key.split("/");
        const channel = parts[0];
        acc[channel] = acc[channel] || [];
        acc[channel].push(key);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    const updatedTargetFiles = new Set<string>();

    for (const channel of Object.keys(keysByChannel)) {
      const updateKeys = keysByChannel[channel];
      const targetKey = `${channel}/${platform}/target-app-versions.json`;
      // Extract targetAppVersion from each update.json file key.
      const currentVersions = updateKeys.map((key) => key.split("/")[2]);
      const oldTargetVersions =
        (await loadObject<string[]>(context, targetKey)) ?? [];
      const newTargetVersions = oldTargetVersions.filter((v) =>
        currentVersions.includes(v),
      );
      for (const v of currentVersions) {
        if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
      }

      if (
        JSON.stringify(oldTargetVersions) !== JSON.stringify(newTargetVersions)
      ) {
        await uploadObject(context, targetKey, newTargetVersions);
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
    context: TContext,
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
        : /^[^\/]+\/[^\/]+\/[^\/]+\/update\.json$/;

    return listObjects(context, prefix).then((keys) =>
      keys.filter((key) => pattern.test(key)),
    );
  }

  return createDatabasePlugin(
    name,
    {
      getContext,
      async getBundleById(context, bundleId: string) {
        const pendingBundle = pendingBundlesMap.get(bundleId);
        if (pendingBundle) {
          return removeBundleInternalKeys(pendingBundle);
        }
        const bundle = bundlesMap.get(bundleId);
        if (bundle) {
          return removeBundleInternalKeys(bundle);
        }
        const bundles = await reloadBundles(context);
        return bundles.find((bundle) => bundle.id === bundleId) ?? null;
      },

      async getBundles(context, options) {
        // Always load the latest data from S3.
        let bundles = await reloadBundles(context);
        const { where, limit, offset = 0 } = options ?? {};
        // Sort bundles in descending order by id.

        // Apply filtering conditions.
        if (where) {
          bundles = bundles.filter((bundle) => {
            return Object.entries(where).every(
              ([key, value]) =>
                value === undefined ||
                value === null ||
                bundle[key as keyof Bundle] === value,
            );
          });
        }

        if (offset > 0) {
          bundles = bundles.slice(offset);
        }
        if (limit) {
          bundles = bundles.slice(0, limit);
        }

        return bundles.map(removeBundleInternalKeys);
      },

      async getChannels(context) {
        const allBundles = await this.getBundles(context);
        return [...new Set(allBundles.map((bundle) => bundle.channel))];
      },

      async commitBundle(context, { changedSets }) {
        if (changedSets.length === 0) return;

        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};
        const pathsToInvalidate: Set<string> = new Set();

        let isTargetAppVersionChanged = false;

        for (const { operation, data } of changedSets) {
          if (data.targetAppVersion !== undefined) {
            isTargetAppVersionChanged = true;
          }
          // Insert operation.
          if (operation === "insert") {
            const target = data.targetAppVersion ?? data.fingerprintHash;
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
              pathsToInvalidate.add(
                `${apiBasePath}/app-version/${data.platform}/${data.targetAppVersion}/${data.channel}/*`,
              );
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
              data.targetAppVersion ??
              bundle.targetAppVersion;
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
              if (bundle.fingerprintHash) {
                pathsToInvalidate.add(
                  `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/${bundle.channel}/*`,
                );
              } else if (bundle.targetAppVersion) {
                pathsToInvalidate.add(
                  `${apiBasePath}/app-version/${bundle.platform}/${bundle.targetAppVersion}/${bundle.channel}/*`,
                );
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

            // CloudFront 무효화를 위한 경로 추가
            pathsToInvalidate.add(`/${currentKey}`);
            if (bundle.fingerprintHash) {
              pathsToInvalidate.add(
                `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/${bundle.channel}/*`,
              );
            } else if (bundle.targetAppVersion) {
              pathsToInvalidate.add(
                `${apiBasePath}/app-version/${bundle.platform}/${bundle.targetAppVersion}/${bundle.channel}/*`,
              );
            }
          }
        }

        // Remove bundles from their old keys.
        for (const oldKey of Object.keys(removalsByKey)) {
          await (async () => {
            const currentBundles =
              (await loadObject<Bundle[]>(context, oldKey)) ?? [];
            const updatedBundles = currentBundles.filter(
              (b) => !removalsByKey[oldKey].includes(b.id),
            );
            updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
            if (updatedBundles.length === 0) {
              await deleteObject(context, oldKey);
            } else {
              await uploadObject(context, oldKey, updatedBundles);
            }
          })();
        }

        // Add or update bundles in their new keys.
        for (const key of Object.keys(changedBundlesByKey)) {
          await (async () => {
            const currentBundles =
              (await loadObject<Bundle[]>(context, key)) ?? [];
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
            await uploadObject(context, key, currentBundles);
          })();
        }

        // Update target-app-versions.json for each platform and collect paths that were actually updated
        const updatedTargetFilePaths = new Set<string>();
        if (isTargetAppVersionChanged) {
          for (const platform of PLATFORMS) {
            const updatedPaths = await updateTargetVersionsForPlatform(
              context,
              platform,
            );
            for (const path of updatedPaths) {
              updatedTargetFilePaths.add(path);
            }
          }
        }

        // Add updated target-app-versions.json paths to invalidation list
        for (const path of updatedTargetFilePaths) {
          pathsToInvalidate.add(path);
        }

        await invalidatePaths(context, Array.from(pathsToInvalidate));

        pendingBundlesMap.clear();
        hooks?.onDatabaseUpdated?.();
      },
    },
    hooks,
  );
};

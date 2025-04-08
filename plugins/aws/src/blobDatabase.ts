import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { orderBy } from "es-toolkit";

/**
File Structure:
- channel
  - platform
    - targetAppVersion
      - update.json
    - target-app-versions.json
- bundle-ids
  - bundle.zip

File Contents: target-app-versions.json
- Array of targetAppVersion strings

File Contents: update.json
- Array of Updates
*/

interface BundleWithUpdateJsonKey extends Bundle {
  _updateJsonKey: string;
  _oldUpdateJsonKey?: string;
}

// Helper function to remove internal management keys
function removeBundleInternalKeys(bundle: BundleWithUpdateJsonKey): Bundle {
  const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
  return pureBundle;
}

export function blobDatabase(
  name: string,
  loadJson: <T>(key: string) => Promise<T | null>,
  uploadJson: <T>(key: string, data: T) => Promise<void>,
  listObjects: (prefix: string) => Promise<string[]>,
  deleteObject: (key: string) => Promise<void>,
  invalidatedPaths: (paths: Set<string>) => Promise<void>,
  hooks?: DatabasePluginHooks
) {
  // Map for O(1) lookup of bundles.
  const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
  // Temporary store for newly added or modified bundles.
  const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();

  const PLATFORMS = ["ios", "android"] as const;

  // Reload all bundle data from S3.
  // TODO - Channel is an option but not callers use it.
  async function reloadBundles(channel?: string) {
    bundlesMap.clear();

    const platformPromises = PLATFORMS.map(async (platform) => {
      const prefix = channel
        ? platform
          ? `${channel}/${platform}/`
          : `${channel}/`
        : "";
      // Retrieve update.json files for the platform across all channels.
      const keys = await listObjects(prefix);
      const filePromises: Promise<Bundle[]>[] = keys.map(async (key) => {
        const bundlesData = (await loadJson<Bundle[]>(key)) ?? [];
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
    platform: string
  ): Promise<Set<string>> {
    // Retrieve all update.json files for the platform across channels.
    const pattern = new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`);
    const keys = (await listUpdateJsonKeys(platform)).filter((key) =>
      pattern.test(key)
    );

    // Group keys by channel (channel is the first part of the key)
    const keysByChannel = keys.reduce((acc, key) => {
      const parts = key.split("/");
      const channel = parts[0];
      acc[channel] = acc[channel] || [];
      acc[channel].push(key);
      return acc;
    }, {} as Record<string, string[]>);

    const updatedTargetFiles = new Set<string>();

    for (const channel of Object.keys(keysByChannel)) {
      const updateKeys = keysByChannel[channel];
      const targetKey = `${channel}/${platform}/target-app-versions.json`;
      // Extract targetAppVersion from each update.json file key.
      const currentVersions = updateKeys.map((key) => key.split("/")[2]);
      const oldTargetVersions = (await loadJson<string[]>(targetKey))   - bundle.zip
      ￼
      ￼
      ?? [];
      const newTargetVersions = oldTargetVersions.filter((v) =>
        currentVersions.includes(v)
      );
      for (const v of currentVersions) {
        if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
      }

      if (
        JSON.stringify(oldTargetVersions) !== JSON.stringify(newTargetVersions)
      ) {
        await uploadJson(targetKey, newTargetVersions);
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
    channel?: string
  ): Promise<string[]> {
    const pattern = channel
      ? platform
        ? new RegExp(`^${channel}/${platform}/[^/]+/update\\.json$`)
        : new RegExp(`^${channel}/[^/]+/[^/]+/update\\.json$`)  - bundle.zip
        ￼
        ￼
        
      : platform
      ? new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`)
      : /^[^\/]+\/[^\/]+\/[^\/]+\/update\.json$/;

    const keys = await listObjects("TODO");
    return keys.filter((key): key is string => !!key && pattern.test(key));
  }  - bundle.zip
  ￼
  ￼
  

  return createDatabasePlugin(
    name,
    {
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
        // Always load the latest data from S3.
        let bundles = await reloadBundles();
        const { where, limit, offset = 0 } = options ?? {};
        // Sort bundles in descending order by id.

        // Apply filtering conditions.
        if (where) {
          bundles = bundles.filter((bundle) => {
            return Object.entries(where).every(
              ([key, value]) =>
                value === undefined ||
                value === null ||
                bundle[key as keyof Bundle] === value
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

      async getChannels() {
        // TODO - remove force cast
        const allBundles: Bundle[] = await this.getBundles();
        return [...new Set(allBundles.map((bundle) => bundle.channel))];
      },

      async commitBundle({
        changedSets,
      }: {
        changedSets: { operation: "insert"; data: Bundle }[];
      }) {
        if (changedSets.length === 0) return;

        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};
        const pathsToInvalidate: Set<string> = new Set();

        for (const { operation, data } of changedSets) {
          // Insert operation.
          if (operation === "insert") {
            const key = `${data.channel}/${data.platform}/${data.targetAppVersion}/update.json`;
            const bundleWithKey: BundleWithUpdateJsonKey = {
              ...data,
              _updateJsonKey: key,
            };

            bundlesMap.set(data.id, bundleWithKey);
            pendingBundlesMap.set(data.id, bundleWithKey);

            changedBundlesByKey[key] = changedBundlesByKey[key] || [];
            changedBundlesByKey[key].push(
              removeBundleInternalKeys(bundleWithKey)
            );

            // CloudFront 무효화를 위한 경로 추가
            pathsToInvalidate.add(`/${key}`);
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
            const newTargetAppVersion =
              data.targetAppVersion !== undefined
                ? data.targetAppVersion
                : bundle.targetAppVersion;
            const newKey = `${newChannel}/${newPlatform}/${newTargetAppVersion}/update.json`;

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
                removeBundleInternalKeys(updatedBundle)
              );

              // Add paths for CloudFront invalidation
              pathsToInvalidate.add(`/${oldKey}`);
              pathsToInvalidate.add(`/${newKey}`);
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
              removeBundleInternalKeys(updatedBundle)
            );

            // CloudFront 무효화를 위한 경로 추가
            pathsToInvalidate.add(`/${currentKey}`);
          }
        }

        // Remove bundles from their old keys.
        for (const oldKey of Object.keys(removalsByKey)) {
          await (async () => {
            const currentBundles = (await loadJson<Bundle[]>(oldKey)) ?? [];
            const updatedBundles = currentBundles.filter(
              (b) => !removalsByKey[oldKey].includes(b.id)
            );
            updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
            if (updatedBundles.length === 0) {
              await deleteObject(oldKey);
            } else {
              await uploadJson(oldKey, updatedBundles);
            }
          })();
        }

        // Add or update bundles in their new keys.
        for (const key of Object.keys(changedBundlesByKey)) {
          await (async () => {
            const currentBundles = (await loadJson<Bundle[]>(key)) ?? [];
            const pureBundles = changedBundlesByKey[key].map(
              (bundle) => bundle
            );
            for (const changedBundle of pureBundles) {
              const index = currentBundles.findIndex(
                (b) => b.id === changedBundle.id
              );
              if (index >= 0) {
                currentBundles[index] = changedBundle;
              } else {
                currentBundles.push(changedBundle);
              }
            }
            currentBundles.sort((a, b) => b.id.localeCompare(a.id));
            await uploadJson(key, currentBundles);
          })();
        }

        // Update target-app-versions.json for each platform and collect paths that were actually updated
        for (const platform of PLATFORMS) {
          const updatedPaths = await updateTargetVersionsForPlatform(platform);

          for (const path of updatedPaths) {
            pathsToInvalidate.add(path);
          }
        }

        await invalidatedPaths(pathsToInvalidate);

        pendingBundlesMap.clear();
        hooks?.onDatabaseUpdated?.();
      },
    },
    hooks
  );
}

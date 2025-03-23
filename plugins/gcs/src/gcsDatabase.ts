import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import {
  getJsonFromGCS,
  uploadJsonToGCS,
  deleteObjectGCS,
  listUpdateJsonKeys,
} from "./utils/gcs";

export interface GCSDatabaseConfig {
  bucketName: string;
}

interface BundleWithUpdateJsonKey extends Bundle {
  _updateJsonKey: string;
  _oldUpdateJsonKey?: string;
}

export const gcsDatabase =
  (config: GCSDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const { bucketName } = config;
    oldPlatform;
    let bundles: BundleWithUpdateJsonKey[] = [];
    const changedIds = new Set<string>();

    const markChanged = (id: string) => changedIds.add(id);
    const PLATFORMS = ["ios", "android"] as const;

    // Update target-app-versions.json for each platform
    async function updateTargetVersionsForPlatform(platform: string) {
      const targetKey = `${platform}/target-app-versions.json`;
      const oldTargetVersions =
        (await getJsonFromGCS<string[]>(bucketName, targetKey)) ?? [];
      const updateKeys = await listUpdateJsonKeys(bucketName, platform);
      const currentVersions = updateKeys.map((key) => key.split("/")[1]);
      const newTargetVersions = oldTargetVersions.filter((v) =>
        currentVersions.includes(v)
      );
      for (const v of currentVersions) {
        if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
      }
      await uploadJsonToGCS(bucketName, targetKey, newTargetVersions);
    }

    // Remove bundles to be moved from existing update.json file
    async function processRemovals(oldKey: string, removalIds: string[]) {
      const currentBundles =
        (await getJsonFromGCS<Bundle[]>(bucketName, oldKey)) ?? [];
      const updatedBundles = currentBundles.filter(
        (b) => !removalIds.includes(b.id)
      );
      updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
      if (updatedBundles.length === 0) {
        await deleteObjectGCS(bucketName, oldKey);
      } else {
        await uploadJsonToGCS(bucketName, oldKey, updatedBundles);
      }
    }

    // Merge changed bundles into new update.json file
    async function mergeChangedBundles(
      updateJsonKey: string,
      changedList: Bundle[]
    ) {
      const currentBundles =
        (await getJsonFromGCS<Bundle[]>(bucketName, updateJsonKey)) ?? [];
      for (const changedBundle of changedList) {
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
      await uploadJsonToGCS(bucketName, updateJsonKey, currentBundles);
    }

    return {
      name: "gcsDatabase",

      async commitBundle() {
        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};

        // Group changed bundles based on snapshot
        for (const bundle of bundles) {
          if (changedIds.has(bundle.id)) {
            if (bundle._oldUpdateJsonKey) {
              removalsByKey[bundle._oldUpdateJsonKey] =
                removalsByKey[bundle._oldUpdateJsonKey] || [];
              removalsByKey[bundle._oldUpdateJsonKey].push(bundle.id);
            }
            const currentKey = bundle._updateJsonKey;
            if (!currentKey) {
              throw new Error(
                `Missing _updateJsonKey for bundle id ${bundle.id}`
              );
            }
            changedBundlesByKey[currentKey] =
              changedBundlesByKey[currentKey] || [];
            const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
            changedBundlesByKey[currentKey].push(pureBundle);
          }
        }

        // Execute GCS updates sequentially (resolve concurrency issues)
        for (const oldKey of Object.keys(removalsByKey)) {
          await processRemovals(oldKey, removalsByKey[oldKey]);
        }

        for (const key of Object.keys(changedBundlesByKey)) {
          await mergeChangedBundles(key, changedBundlesByKey[key]);
        }

        for (const platform of PLATFORMS) {
          await updateTargetVersionsForPlatform(platform);
        }

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },

      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const index = bundles.findIndex((u) => u.id === targetBundleId);
        if (index === -1) {
          throw new Error("target bundle version not found");
        }
        const original = bundles[index];
        const {
          platform: oldPlatform,
          targetAppVersion: oldTargetAppVersion,
          _updateJsonKey: oldUpdateJsonKey,
        } = original;
        const newPlatform = newBundle.platform ?? original.platform;
        const newTargetAppVersion =
          newBundle.targetAppVersion ?? original.targetAppVersion;

        if (
          newPlatform !== oldPlatform ||
          newTargetAppVersion !== oldTargetAppVersion
        ) {
          original._oldUpdateJsonKey = oldUpdateJsonKey;
          original._updateJsonKey = `${newPlatform}/${newTargetAppVersion}/update.json`;
        }
        Object.assign(original, newBundle);
        markChanged(original.id);
      },

      async getBundleById(bundleId: string) {
        const bundle = bundles.find((b) => b.id === bundleId);
        if (!bundle) return null;
        const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
        return pureBundle;
      },

      async getBundles(refresh = false) {
        if (!refresh && bundles.length > 0) {
          return bundles.map(
            ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle
          );
        }

        const platformPromises = PLATFORMS.map(async (platform) => {
          const keys = await listUpdateJsonKeys(bucketName, platform);
          const filePromises = keys.map(async (key) => {
            const bundlesData =
              (await getJsonFromGCS<Bundle[]>(bucketName, key)) ?? [];
            return bundlesData.map((bundle) => ({
              ...bundle,
              _updateJsonKey: key,
            }));
          });
          const results = await Promise.all(filePromises);
          return results.flat();
        });
        const allBundles = (await Promise.all(platformPromises)).flat();
        allBundles.sort((a, b) => b.id.localeCompare(a.id));
        bundles = allBundles;
        return bundles.map(
          ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle
        );
      },

      async appendBundle(inputBundle: Bundle) {
        bundles.unshift({
          ...inputBundle,
          _updateJsonKey: `${inputBundle.platform}/${inputBundle.targetAppVersion}/update.json`,
        });
        markChanged(inputBundle.id);
      },
    };
  };

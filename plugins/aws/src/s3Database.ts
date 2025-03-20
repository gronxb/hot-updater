import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import mime from "mime";
import { streamToString } from "./utils/streamToString";

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
}

interface BundleWithUpdateJsonKey extends Bundle {
  _updateJsonKey: string;
  _oldUpdateJsonKey?: string;
}

/**
 * Loads JSON data from S3.
 * Returns null if NoSuchKey error occurs.
 */
async function loadJsonFromS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<T | null> {
  try {
    const { Body } = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!Body) return null;
    const bodyContents = await streamToString(Body);
    return JSON.parse(bodyContents) as T;
  } catch (e) {
    if (e instanceof NoSuchKey) return null;
    throw e;
  }
}

/**
 * Converts data to JSON string and uploads to S3.
 */
async function uploadJsonToS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
  data: T,
) {
  const Body = JSON.stringify(data);
  const ContentType = mime.getType(key) ?? "application/json";
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body, ContentType },
  });
  await upload.done();
}

// Helper function to remove internal management keys
function removeBundleInternalKeys(bundle: BundleWithUpdateJsonKey): Bundle {
  const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
  return pureBundle;
}

/**
 * Lists update.json keys for a given platform.
 *
 * - If a channel is provided, only that channel’s update.json files are listed.
 * - Otherwise, all channels for the given platform are returned.
 */
async function listUpdateJsonKeys(
  client: S3Client,
  bucketName: string,
  platform: string,
  channel?: string,
): Promise<string[]> {
  let continuationToken: string | undefined;
  const keys: string[] = [];
  const prefix = channel ? `${channel}/${platform}/` : "";
  // Use appropriate key format based on whether a channel is given.
  const pattern = channel
    ? new RegExp(`^${channel}/${platform}/[^/]+/update\\.json$`)
    : new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`);
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const found = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => !!key && pattern.test(key));
    keys.push(...found);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

/**
 * Updates target-app-versions.json for each channel on the given platform.
 */
async function updateTargetVersionsForPlatform(
  client: S3Client,
  bucketName: string,
  platform: string,
) {
  // Retrieve all update.json files for the platform across channels.
  let continuationToken: string | undefined;
  const keys: string[] = [];
  const pattern = new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`);
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: "",
        ContinuationToken: continuationToken,
      }),
    );
    const found = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => !!key && pattern.test(key));
    keys.push(...found);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

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

  for (const channel of Object.keys(keysByChannel)) {
    const updateKeys = keysByChannel[channel];
    const targetKey = `${channel}/${platform}/target-app-versions.json`;
    // Extract targetAppVersion from each update.json file key.
    const currentVersions = updateKeys.map((key) => key.split("/")[2]);
    const oldTargetVersions =
      (await loadJsonFromS3<string[]>(client, bucketName, targetKey)) ?? [];
    const newTargetVersions = oldTargetVersions.filter((v) =>
      currentVersions.includes(v),
    );
    for (const v of currentVersions) {
      if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
    }
    await uploadJsonToS3(client, bucketName, targetKey, newTargetVersions);
  }
}

export const s3Database = (
  config: S3DatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const { bucketName, ...s3Config } = config;
  const client = new S3Client(s3Config);

  // Map for O(1) lookup of bundles.
  const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
  // Temporary store for newly added or modified bundles.
  const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();

  const PLATFORMS = ["ios", "android"] as const;

  // Reload all bundle data from S3.
  async function reloadBundles() {
    bundlesMap.clear();

    const platformPromises = PLATFORMS.map(async (platform) => {
      // Retrieve update.json files for the platform across all channels.
      const keys = await listUpdateJsonKeys(client, bucketName, platform);
      const filePromises = keys.map(async (key) => {
        const bundlesData =
          (await loadJsonFromS3<Bundle[]>(client, bucketName, key)) ?? [];
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

    return allBundles;
  }

  return createDatabasePlugin(
    "s3Database",
    {
      async getBundleById(bundleId: string) {
        const pendingBundle = pendingBundlesMap.get(bundleId);
        if (pendingBundle) {
          return removeBundleInternalKeys(pendingBundle);
        }
        const bundle = bundlesMap.get(bundleId);
        if (!bundle) return null;
        return removeBundleInternalKeys(bundle);
      },

      async getBundles(options) {
        // Always load the latest data from S3.
        await reloadBundles();

        const { where, limit, offset = 0 } = options ?? {};
        let bundlesArray = Array.from(bundlesMap.values());

        // Sort bundles in descending order by id.
        bundlesArray.sort((a, b) => b.id.localeCompare(a.id));

        // Apply filtering conditions.
        if (where) {
          bundlesArray = bundlesArray.filter((bundle) => {
            return Object.entries(where).every(
              ([key, value]) => bundle[key as keyof Bundle] === value,
            );
          });
        }

        if (offset > 0) {
          bundlesArray = bundlesArray.slice(offset);
        }
        if (limit) {
          bundlesArray = bundlesArray.slice(0, limit);
        }

        return bundlesArray.map(removeBundleInternalKeys);
      },

      async getChannels() {
        const allBundles = await this.getBundles();
        return [...new Set(allBundles.map((bundle) => bundle.channel))];
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) return;

        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};

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
              removeBundleInternalKeys(bundleWithKey),
            );
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
                removeBundleInternalKeys(updatedBundle),
              );
              continue;
            } else {
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
            }
          }
        }

        // Remove bundles from their old keys.
        for (const oldKey of Object.keys(removalsByKey)) {
          await (async () => {
            const currentBundles =
              (await loadJsonFromS3<Bundle[]>(client, bucketName, oldKey)) ??
              [];
            const updatedBundles = currentBundles.filter(
              (b) => !removalsByKey[oldKey].includes(b.id),
            );
            updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
            if (updatedBundles.length === 0) {
              await client.send(
                new DeleteObjectCommand({ Bucket: bucketName, Key: oldKey }),
              );
            } else {
              await uploadJsonToS3(client, bucketName, oldKey, updatedBundles);
            }
          })();
        }

        // Add or update bundles in their new keys.
        for (const key of Object.keys(changedBundlesByKey)) {
          await (async () => {
            const currentBundles =
              (await loadJsonFromS3<Bundle[]>(client, bucketName, key)) ?? [];
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
            await uploadJsonToS3(client, bucketName, key, currentBundles);
          })();
        }

        // Update target-app-versions.json for each platform.
        for (const platform of PLATFORMS) {
          await updateTargetVersionsForPlatform(client, bucketName, platform);
        }

        pendingBundlesMap.clear();
        hooks?.onDatabaseUpdated?.();
      },
    },
    hooks,
  );
};

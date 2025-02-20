import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import mime from "mime";
import { streamToString } from "./utils/streamToString";

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
}

interface BundleWithUpdateJsonKey extends Bundle {
  /** Path to update.json that this bundle belongs to */
  _updateJsonKey: string;
}

/**
 * Loads and parses a JSON object from S3 as type T.
 * Handles NoSuchKey to return null (or default value) if object doesn't exist.
 */
async function loadJsonFromS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<T | null> {
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const { Body } = await client.send(getCommand);
    if (!Body) {
      return null;
    }
    const bodyContents = await streamToString(Body);
    return JSON.parse(bodyContents) as T;
  } catch (e) {
    if (e instanceof NoSuchKey) {
      return null;
    }
    throw e; // Throw other errors up
  }
}

/**
 * Converts data of type T to JSON string and uploads to S3
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
    params: {
      Bucket: bucket,
      Key: key,
      Body,
      ContentType,
    },
  });
  await upload.done();
}

/**
 * Upserts a new version into target-app-versions.json in the platform folder
 */
async function upsertTargetAppVersions(
  client: S3Client,
  bucketName: string,
  platform: string,
  version: string,
) {
  const targetKey = `${platform}/target-app-versions.json`;
  const versions =
    (await loadJsonFromS3<string[]>(client, bucketName, targetKey)) ?? [];

  if (!versions.includes(version)) {
    versions.push(version);
    versions.sort(); // Sort version names (optional)
    await uploadJsonToS3(client, bucketName, targetKey, versions);
  }
}

// ---------------------
// Main Plugin
// ---------------------
export const s3Database =
  (config: S3DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    // Bundles cached in memory
    let bundles: BundleWithUpdateJsonKey[] = [];

    // Track IDs to detect changes
    const changedIds = new Set<string>();

    // Record platform version updates as "(platform):(version)"
    const changedPlatformVersions = new Set<string>();

    /**
     * Mark a bundle ID as changed
     */
    function markChanged(id: string) {
      changedIds.add(id);
    }

    /**
     * Mark a (platform, version) pair as changed
     */
    function markPlatformVersionChanged(platform: string, version: string) {
      changedPlatformVersions.add(`${platform}:${version}`);
    }

    // ---------------------
    // DatabasePlugin Implementation
    // ---------------------
    return {
      name: "s3Database",

      /**
       * Commits changed bundles to S3 and updates target-app-versions.json
       * for changed (platform, version) pairs
       */
      async commitBundle() {
        // 1) Group changed bundles by update.json path
        const changedBundlesByKey: Record<string, Bundle[]> = {};
        for (const bundle of bundles) {
          if (changedIds.has(bundle.id)) {
            const { _updateJsonKey, ...pureBundle } = bundle;
            if (!_updateJsonKey) {
              throw new Error(
                `Missing _updateJsonKey for bundle id ${bundle.id}`,
              );
            }
            if (!changedBundlesByKey[_updateJsonKey]) {
              changedBundlesByKey[_updateJsonKey] = [];
            }
            changedBundlesByKey[_updateJsonKey].push(pureBundle);
          }
        }

        // 2) Load each update.json and upsert changed bundles
        for (const updateJsonKey of Object.keys(changedBundlesByKey)) {
          const currentBundles =
            (await loadJsonFromS3<Bundle[]>(
              client,
              bucketName,
              updateJsonKey,
            )) ?? [];
          const changedList = changedBundlesByKey[updateJsonKey];

          // upsert (replace if exists, insert if not)
          for (const changedBundle of changedList) {
            const index = currentBundles.findIndex(
              (b) => b.id === changedBundle.id,
            );
            if (index >= 0) {
              currentBundles[index] = changedBundle;
            } else {
              currentBundles.push(changedBundle);
            }
          }

          // Sort by ID ascending/descending (using localeCompare like existing code)
          currentBundles.sort((a, b) => b.id.localeCompare(a.id));

          // Upload modified list
          await uploadJsonToS3(
            client,
            bucketName,
            updateJsonKey,
            currentBundles,
          );
        }

        // 3) Update target-app-versions.json for changed platform-version pairs
        for (const pv of changedPlatformVersions) {
          const [platform, version] = pv.split(":");
          await upsertTargetAppVersions(client, bucketName, platform, version);
        }

        // 4) Reset change flags & call hooks
        changedIds.clear();
        changedPlatformVersions.clear();
        hooks?.onDatabaseUpdated?.();
      },

      /**
       * Find a bundle by ID and override with newBundle info
       */
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const index = bundles.findIndex((u) => u.id === targetBundleId);
        if (index === -1) {
          throw new Error("target bundle version not found");
        }

        const original = bundles[index];
        Object.assign(original, newBundle);

        // Mark as changed
        markChanged(original.id);

        // Mark platform/version changes in changedPlatformVersions
        markPlatformVersionChanged(
          original.platform,
          original.targetAppVersion,
        );
      },

      /**
       * Add a new bundle
       */
      async appendBundle(inputBundle) {
        bundles.unshift({
          ...inputBundle,
          _updateJsonKey: `${inputBundle.platform}/${inputBundle.targetAppVersion}/update.json`,
        });

        markChanged(inputBundle.id);
        // Register (platform, version) at append
        markPlatformVersionChanged(
          inputBundle.platform,
          inputBundle.targetAppVersion,
        );
      },

      /**
       * Return a bundle by ID from memory cache
       */
      async getBundleById(bundleId) {
        return bundles.find((b) => b.id === bundleId) ?? null;
      },

      /**
       * Return all bundles (reload from S3 and update cache if refresh=true)
       * Current implementation doesn't use target-app-versions.json yet,
       * but could be improved to first read target-app-versions.json
       * then load update.json from each version folder
       */
      async getBundles(refresh = false) {
        // Return cache if available
        if (!refresh && bundles.length > 0) {
          return bundles;
        }

        const platforms = ["ios", "android"];
        const allBundles: BundleWithUpdateJsonKey[] = [];

        // Search for <platform>/**/update.json across all platforms
        for (const platform of platforms) {
          let continuationToken: string | undefined;
          const keys: string[] = [];

          // 1) Use ListObjectsV2 to find all update.json paths under <platform>/
          do {
            const listCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${platform}/`,
              ContinuationToken: continuationToken,
            });
            const response = await client.send(listCommand);
            const foundKeys = (response.Contents ?? [])
              .map((item) => item.Key)
              .filter((key): key is string => !!key)
              .filter((key) =>
                // Folder structure: <platform>/<targetAppVersion>/update.json
                new RegExp(`^${platform}/[^/]+/update\\.json$`).test(key),
              );

            keys.push(...foundKeys);
            continuationToken = response.NextContinuationToken;
          } while (continuationToken);

          // 2) Load each found update.json file
          for (const key of keys) {
            const bundlesData =
              (await loadJsonFromS3<Bundle[]>(client, bucketName, key)) ?? [];
            const decorated = bundlesData.map((bundle) => ({
              ...bundle,
              _updateJsonKey: key,
            }));
            allBundles.push(...decorated);
          }
        }

        // 3) Sort all and save to cache
        allBundles.sort((a, b) => b.id.localeCompare(a.id));
        bundles = allBundles;
        return bundles;
      },
    };
  };

import {
  DeleteObjectCommand,
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

export const s3Database =
  (config: S3DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    let bundles: BundleWithUpdateJsonKey[] = [];
    const changedIds = new Set<string>();

    const markChanged = (id: string) => changedIds.add(id);
    const PLATFORMS = ["ios", "android"] as const;

    // List update.json paths for each platform in parallel
    async function listUpdateJsonKeys(platform: string): Promise<string[]> {
      let continuationToken: string | undefined;
      const keys: string[] = [];
      const pattern = new RegExp(`^${platform}/[^/]+/update\\.json$`);
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `${platform}/`,
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

    // Update target-app-versions.json for each platform
    async function updateTargetVersionsForPlatform(platform: string) {
      const targetKey = `${platform}/target-app-versions.json`;
      const oldTargetVersions =
        (await loadJsonFromS3<string[]>(client, bucketName, targetKey)) ?? [];
      const updateKeys = await listUpdateJsonKeys(platform);
      const currentVersions = updateKeys.map((key) => key.split("/")[1]);
      const newTargetVersions = oldTargetVersions.filter((v) =>
        currentVersions.includes(v),
      );
      for (const v of currentVersions) {
        if (!newTargetVersions.includes(v)) newTargetVersions.push(v);
      }
      await uploadJsonToS3(client, bucketName, targetKey, newTargetVersions);
    }

    // Remove bundles to be moved from existing update.json file
    async function processRemovals(oldKey: string, removalIds: string[]) {
      const currentBundles =
        (await loadJsonFromS3<Bundle[]>(client, bucketName, oldKey)) ?? [];
      const updatedBundles = currentBundles.filter(
        (b) => !removalIds.includes(b.id),
      );
      updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
      if (updatedBundles.length === 0) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: oldKey }),
        );
      } else {
        await uploadJsonToS3(client, bucketName, oldKey, updatedBundles);
      }
    }

    // Merge changed bundles into new update.json file
    async function mergeChangedBundles(
      updateJsonKey: string,
      changedList: Bundle[],
    ) {
      const currentBundles =
        (await loadJsonFromS3<Bundle[]>(client, bucketName, updateJsonKey)) ??
        [];
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
      currentBundles.sort((a, b) => b.id.localeCompare(a.id));
      await uploadJsonToS3(client, bucketName, updateJsonKey, currentBundles);
    }

    return {
      name: "s3Database",

      async commitBundle() {
        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};

        // 스냅샷을 기반으로 변경된 번들을 그룹화
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
                `Missing _updateJsonKey for bundle id ${bundle.id}`,
              );
            }
            changedBundlesByKey[currentKey] =
              changedBundlesByKey[currentKey] || [];
            const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
            changedBundlesByKey[currentKey].push(pureBundle);
          }
        }

        // 순차적으로 S3 업데이트 실행 (동시성 문제 해결)
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
            ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle,
          );
        }

        const platformPromises = PLATFORMS.map(async (platform) => {
          const keys = await listUpdateJsonKeys(platform);
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
        allBundles.sort((a, b) => b.id.localeCompare(a.id));
        bundles = allBundles;
        return bundles.map(
          ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle,
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

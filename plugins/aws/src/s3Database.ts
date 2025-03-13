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

// 내부 관리 키를 제거하는 헬퍼 함수
function removeBundleInternalKeys(bundle: BundleWithUpdateJsonKey): Bundle {
  const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
  return pureBundle;
}

export const s3Database = (
  config: S3DatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const { bucketName, ...s3Config } = config;
  const client = new S3Client(s3Config);

  // Map으로 변경하여 O(1) 조회 가능하게 함
  const bundlesMap = new Map<string, BundleWithUpdateJsonKey>();
  // 새로 추가된 번들을 임시 저장하는 Map
  const pendingBundlesMap = new Map<string, BundleWithUpdateJsonKey>();

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
      (await loadJsonFromS3<Bundle[]>(client, bucketName, updateJsonKey)) ?? [];

    // 먼저 내부 관리 키 제거
    const pureBundles = changedList.map((bundle) => {
      if ("_updateJsonKey" in bundle || "_oldUpdateJsonKey" in bundle) {
        return removeBundleInternalKeys(bundle as BundleWithUpdateJsonKey);
      }
      return bundle;
    });

    for (const changedBundle of pureBundles) {
      const index = currentBundles.findIndex((b) => b.id === changedBundle.id);
      if (index >= 0) {
        currentBundles[index] = changedBundle;
      } else {
        currentBundles.push(changedBundle);
      }
    }

    // Sort bundles in descending order by id
    currentBundles.sort((a, b) => b.id.localeCompare(a.id));

    await uploadJsonToS3(client, bucketName, updateJsonKey, currentBundles);
  }

  // 모든 번들 데이터를 다시 로드
  async function reloadBundles() {
    // 먼저 Map을 비워 이전 상태를 초기화
    bundlesMap.clear();

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

    for (const bundle of allBundles) {
      bundlesMap.set(bundle.id, bundle as BundleWithUpdateJsonKey);
    }

    // 보류 중이던 번들들도 Map에 추가
    for (const [id, bundle] of pendingBundlesMap.entries()) {
      bundlesMap.set(id, bundle);
    }

    return allBundles;
  }

  return createDatabasePlugin(
    "s3Database",
    {
      async getBundleById(bundleId: string) {
        // 먼저 보류 중인 번들에서 확인
        const pendingBundle = pendingBundlesMap.get(bundleId);
        if (pendingBundle) {
          return removeBundleInternalKeys(pendingBundle);
        }

        // 그 다음 메인 Map에서 확인
        const bundle = bundlesMap.get(bundleId);
        if (!bundle) return null;
        return removeBundleInternalKeys(bundle);
      },

      async getBundles(options) {
        // 항상 S3에서 새로운 데이터를 로드하도록 수정
        await reloadBundles();

        const { where, limit, offset = 0 } = options ?? {};

        // Map의 모든 값을 배열로 변환 (보류 중인 번들 포함)
        let bundlesArray = Array.from(bundlesMap.values());

        // 정렬: id 기준 내림차순
        bundlesArray.sort((a, b) => b.id.localeCompare(a.id));

        // where 조건 필터링
        if (where) {
          bundlesArray = bundlesArray.filter((bundle) => {
            return Object.entries(where).every(
              ([key, value]) => bundle[key as keyof Bundle] === value,
            );
          });
        }

        // offset 적용
        if (offset > 0) {
          bundlesArray = bundlesArray.slice(offset);
        }

        // limit 적용
        if (limit) {
          bundlesArray = bundlesArray.slice(0, limit);
        }

        // 내부 관리 키 제거
        return bundlesArray.map(removeBundleInternalKeys);
      },

      async getChannels() {
        const allBundles = await this.getBundles();
        return [...new Set(allBundles.map((bundle) => bundle.channel))];
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        const changedBundlesByKey: Record<string, Bundle[]> = {};
        const removalsByKey: Record<string, string[]> = {};

        for (const { operation, data } of changedSets) {
          // insert 작업인 경우 번들을 맵에 추가
          if (operation === "insert") {
            const key = `${data.platform}/${data.targetAppVersion}/update.json`;
            const bundleWithKey: BundleWithUpdateJsonKey = {
              ...data,
              _updateJsonKey: key,
            };

            // 메인 맵과 보류 맵 모두에 추가
            bundlesMap.set(data.id, bundleWithKey);
            pendingBundlesMap.set(data.id, bundleWithKey);

            changedBundlesByKey[key] = changedBundlesByKey[key] || [];
            changedBundlesByKey[key].push(
              removeBundleInternalKeys(bundleWithKey),
            );
            continue;
          }

          // update/delete 작업일 경우 번들 확인 (보류 맵부터 확인)
          let bundle = pendingBundlesMap.get(data.id);
          if (!bundle) {
            bundle = bundlesMap.get(data.id);
          }

          if (!bundle) continue;

          // 번들의 targetAppVersion이 변경된 경우
          if (
            operation === "update" &&
            data.targetAppVersion !== bundle.targetAppVersion
          ) {
            const oldKey = bundle._updateJsonKey;
            const newKey = `${data.platform}/${data.targetAppVersion}/update.json`;

            // 이전 위치에서 제거할 목록에 추가
            removalsByKey[oldKey] = removalsByKey[oldKey] || [];
            removalsByKey[oldKey].push(bundle.id);

            // 새 위치에 추가할 목록에 추가
            changedBundlesByKey[newKey] = changedBundlesByKey[newKey] || [];

            // 번들 업데이트 (메모리)
            const updatedBundle = { ...bundle, ...data };
            updatedBundle._oldUpdateJsonKey = oldKey;
            updatedBundle._updateJsonKey = newKey;

            bundlesMap.set(data.id, updatedBundle);
            pendingBundlesMap.set(data.id, updatedBundle);

            // S3에 저장할 땐 순수 번들만 포함
            changedBundlesByKey[newKey].push(
              removeBundleInternalKeys(updatedBundle),
            );
            continue;
          }

          // 일반적인 업데이트
          if (operation === "update") {
            const currentKey = bundle._updateJsonKey;

            // 번들 업데이트 (메모리)
            const updatedBundle = { ...bundle, ...data };
            bundlesMap.set(data.id, updatedBundle);
            pendingBundlesMap.set(data.id, updatedBundle);

            // 변경된 번들 목록에 추가
            changedBundlesByKey[currentKey] =
              changedBundlesByKey[currentKey] || [];
            changedBundlesByKey[currentKey].push(
              removeBundleInternalKeys(updatedBundle),
            );
          }
        }

        // 먼저 이전 위치에서 번들 제거
        for (const oldKey of Object.keys(removalsByKey)) {
          await processRemovals(oldKey, removalsByKey[oldKey]);
        }

        // 새로운 위치에 번들 추가/업데이트
        for (const key of Object.keys(changedBundlesByKey)) {
          await mergeChangedBundles(key, changedBundlesByKey[key]);
        }

        // 각 플랫폼의 target-app-versions.json 업데이트
        for (const platform of PLATFORMS) {
          await updateTargetVersionsForPlatform(platform);
        }

        // 성공적으로 commit 후 보류 맵 초기화
        pendingBundlesMap.clear();

        hooks?.onDatabaseUpdated?.();
      },
    },
    hooks,
  );
};

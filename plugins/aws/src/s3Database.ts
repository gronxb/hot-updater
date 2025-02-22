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
  /** Path to update.json that this bundle belongs to */
  _updateJsonKey: string;
  /** (Optional) 이전 update.json 경로 */
  _oldUpdateJsonKey?: string;
}

/**
 * S3에서 JSON 데이터를 로드합니다.
 * NoSuchKey인 경우 null을 반환합니다.
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
    throw e;
  }
}

/**
 * 데이터를 JSON 문자열로 변환 후 S3에 업로드합니다.
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
 * S3Database 플러그인
 */
export const s3Database =
  (config: S3DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    // 메모리 캐시상의 번들 목록
    let bundles: BundleWithUpdateJsonKey[] = [];

    // 변경된 번들 ID 추적
    const changedIds = new Set<string>();

    /**
     * 번들 ID를 변경됨으로 마크합니다.
     */
    function markChanged(id: string) {
      changedIds.add(id);
    }

    // ---------------------
    // DatabasePlugin 구현
    // ---------------------
    return {
      name: "s3Database",

      /**
       * S3에 변경된 번들들을 커밋합니다.
       * - 이동이 발생한 경우 기존 update.json 파일에서 번들을 제거하고, 파일이 비어있으면 삭제합니다.
       * - 변경된 번들은 새 update.json 파일에 병합됩니다.
       * - 각 플랫폼의 target-app-versions.json 파일은 S3에 존재하는 update.json 파일들을 기준으로 업데이트됩니다.
       */
      async commitBundle() {
        // 각 update.json 경로별로 변경된 번들을 그룹화합니다.
        const changedBundlesByKey: Record<string, Bundle[]> = {};
        // 기존 update.json 파일에서 제거할 번들 ID 목록 (이동 대상)
        const removalsByKey: Record<string, string[]> = {};

        for (const bundle of bundles) {
          if (changedIds.has(bundle.id)) {
            if (bundle._oldUpdateJsonKey) {
              const oldKey = bundle._oldUpdateJsonKey;
              removalsByKey[oldKey] = removalsByKey[oldKey] || [];
              removalsByKey[oldKey].push(bundle.id);
            }
            const currentKey = bundle._updateJsonKey;
            if (!currentKey) {
              throw new Error(
                `Missing _updateJsonKey for bundle id ${bundle.id}`,
              );
            }
            changedBundlesByKey[currentKey] =
              changedBundlesByKey[currentKey] || [];
            // S3에 업로드할 때는 _updateJsonKey, _oldUpdateJsonKey를 제거합니다.
            const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
            changedBundlesByKey[currentKey].push(pureBundle);
          }
        }

        // 1) 기존 update.json 파일에서 이동 대상 번들을 제거합니다.
        for (const oldKey of Object.keys(removalsByKey)) {
          const currentBundles =
            (await loadJsonFromS3<Bundle[]>(client, bucketName, oldKey)) ?? [];
          const updatedBundles = currentBundles.filter(
            (b) => !removalsByKey[oldKey].includes(b.id),
          );
          updatedBundles.sort((a, b) => b.id.localeCompare(a.id));
          if (updatedBundles.length === 0) {
            // 파일이 비어 있으면 S3에서 삭제합니다.
            await client.send(
              new DeleteObjectCommand({ Bucket: bucketName, Key: oldKey }),
            );
          } else {
            await uploadJsonToS3(client, bucketName, oldKey, updatedBundles);
          }
        }

        // 2) 변경된 번들을 새 update.json 파일에 병합합니다.
        for (const updateJsonKey of Object.keys(changedBundlesByKey)) {
          const currentBundles =
            (await loadJsonFromS3<Bundle[]>(
              client,
              bucketName,
              updateJsonKey,
            )) ?? [];
          const changedList = changedBundlesByKey[updateJsonKey];
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
          await uploadJsonToS3(
            client,
            bucketName,
            updateJsonKey,
            currentBundles,
          );
        }

        // 3) 각 플랫폼별로 target-app-versions.json 업데이트
        // 기존 파일 순서를 유지하면서, S3에 존재하는 update.json 파일의 버전 목록을 반영합니다.
        const platforms = ["ios", "android"];
        for (const platform of platforms) {
          const targetKey = `${platform}/target-app-versions.json`;
          const oldTargetVersions =
            (await loadJsonFromS3<string[]>(client, bucketName, targetKey)) ??
            [];

          // ListObjectsV2를 사용해 현재 존재하는 update.json 파일 목록 조회
          let continuationToken: string | undefined;
          const updateKeys: string[] = [];
          do {
            const listCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${platform}/`,
              ContinuationToken: continuationToken,
            });
            const response = await client.send(listCommand);
            const foundKeys = (response.Contents ?? [])
              .map((item) => item.Key)
              .filter((key): key is string =>
                new RegExp(`^${platform}/[^/]+/update\\.json$`).test(key),
              );
            updateKeys.push(...foundKeys);
            continuationToken = response.NextContinuationToken;
          } while (continuationToken);

          // 각 키에서 버전 추출
          const currentVersions = updateKeys.map((key) => key.split("/")[1]);
          // 기존 target-app-versions 순서를 유지하되, 현재 존재하는 버전만 유지하고
          // 새롭게 등장한 버전은 순서의 마지막에 추가합니다.
          const newTargetVersions = oldTargetVersions.filter((v) =>
            currentVersions.includes(v),
          );
          for (const v of currentVersions) {
            if (!newTargetVersions.includes(v)) {
              newTargetVersions.push(v);
            }
          }
          await uploadJsonToS3(
            client,
            bucketName,
            targetKey,
            newTargetVersions,
          );
        }

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },

      /**
       * 번들 ID로 번들을 찾아 업데이트합니다.
       */
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const index = bundles.findIndex((u) => u.id === targetBundleId);
        if (index === -1) {
          throw new Error("target bundle version not found");
        }
        const original = bundles[index];
        const oldPlatform = original.platform;
        const oldTargetAppVersion = original.targetAppVersion;
        const oldUpdateJsonKey = original._updateJsonKey;

        const newPlatform = newBundle.platform ?? original.platform;
        const newTargetAppVersion =
          newBundle.targetAppVersion ?? original.targetAppVersion;

        if (
          newPlatform !== oldPlatform ||
          newTargetAppVersion !== oldTargetAppVersion
        ) {
          const newUpdateJsonKey = `${newPlatform}/${newTargetAppVersion}/update.json`;
          original._oldUpdateJsonKey = oldUpdateJsonKey;
          original._updateJsonKey = newUpdateJsonKey;
        }
        Object.assign(original, newBundle);
        markChanged(original.id);
      },

      /**
       * 번들 ID로 번들을 메모리 캐시에서 조회합니다.
       */
      async getBundleById(bundleId: string) {
        const bundle = bundles.find((b) => b.id === bundleId);
        if (!bundle) return null;
        const { _updateJsonKey, _oldUpdateJsonKey, ...pureBundle } = bundle;
        return pureBundle;
      },

      /**
       * 모든 번들을 반환합니다.
       * refresh가 true이면 S3에서 재로딩하고 캐시를 업데이트합니다.
       */
      async getBundles(refresh = false) {
        if (!refresh && bundles.length > 0) {
          return bundles.map(
            ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle,
          );
        }
        const platforms = ["ios", "android"];
        const allBundles: BundleWithUpdateJsonKey[] = [];

        for (const platform of platforms) {
          let continuationToken: string | undefined;
          const keys: string[] = [];
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
                new RegExp(`^${platform}/[^/]+/update\\.json$`).test(key),
              );
            keys.push(...foundKeys);
            continuationToken = response.NextContinuationToken;
          } while (continuationToken);

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

        allBundles.sort((a, b) => b.id.localeCompare(a.id));
        bundles = allBundles;
        return bundles.map(
          ({ _updateJsonKey, _oldUpdateJsonKey, ...bundle }) => bundle,
        );
      },

      /**
       * 새로운 번들을 추가합니다.
       */
      async appendBundle(inputBundle) {
        bundles.unshift({
          ...inputBundle,
          _updateJsonKey: `${inputBundle.platform}/${inputBundle.targetAppVersion}/update.json`,
        });
        markChanged(inputBundle.id);
      },
    };
  };

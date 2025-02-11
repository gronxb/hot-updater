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
  _updateJsonKey: string;
}

export const s3Database =
  (config: S3DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    let bundles: BundleWithUpdateJsonKey[] = [];

    const changedIds = new Set<string>();
    function markChanged(id: string) {
      changedIds.add(id);
    }

    return {
      name: "s3Database",
      async commitBundle() {
        const changedBundlesByKey: Record<string, Bundle[]> = {};
        for (const bundleWithUpdateJsonKey of bundles) {
          if (changedIds.has(bundleWithUpdateJsonKey.id)) {
            const { _updateJsonKey, ...bundle } = bundleWithUpdateJsonKey;
            if (!_updateJsonKey) {
              throw new Error(
                `Missing _updateJsonKey for bundle id ${bundle.id}`,
              );
            }
            if (!changedBundlesByKey[_updateJsonKey]) {
              changedBundlesByKey[_updateJsonKey] = [];
            }
            changedBundlesByKey[_updateJsonKey].push(bundle);
          }
        }

        for (const updateJsonKey of Object.keys(changedBundlesByKey)) {
          let currentBundles: Bundle[] = [];
          try {
            const getCommand = new GetObjectCommand({
              Bucket: bucketName,
              Key: updateJsonKey,
            });
            const { Body } = await client.send(getCommand);
            const bodyContents = await streamToString(Body);
            currentBundles = JSON.parse(bodyContents) as Bundle[];
          } catch (e) {
            if (!(e instanceof NoSuchKey)) {
              throw e;
            }
            currentBundles = [];
          }

          for (const changedBundle of changedBundlesByKey[updateJsonKey]) {
            const index = currentBundles.findIndex(
              (b) => b.id === changedBundle.id,
            );
            if (index !== -1) {
              currentBundles[index] = changedBundle;
            } else {
              currentBundles.push(changedBundle);
            }
          }

          currentBundles.sort((a, b) => b.id.localeCompare(a.id));

          const Body = JSON.stringify(currentBundles);
          const ContentType = mime.getType(updateJsonKey) ?? undefined;

          const upload = new Upload({
            client,
            params: {
              Bucket: bucketName,
              Key: updateJsonKey,
              Body,
              ContentType,
            },
          });
          await upload.done();
        }

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
        markChanged(targetBundleId);
      },
      async appendBundle(inputBundle) {
        bundles.unshift({
          ...inputBundle,
          _updateJsonKey: `${inputBundle.platform}/${inputBundle.targetAppVersion}/update.json`,
        });
        markChanged(inputBundle.id);
      },
      async getBundleById(bundleId) {
        return bundles.find((bundle) => bundle.id === bundleId) ?? null;
      },
      async getBundles(refresh = false): Promise<BundleWithUpdateJsonKey[]> {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const platforms = ["ios", "android"];
        const allBundles: BundleWithUpdateJsonKey[] = [];

        for (const platform of platforms) {
          let continuationToken: string | undefined = undefined;
          const keys: string[] = [];

          do {
            const listCommand: ListObjectsV2Command = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${platform}/`,
              ContinuationToken: continuationToken,
            });
            const response = await client.send(listCommand);
            const platformKeys = (response.Contents || [])
              .map((item) => item.Key)
              .filter((key): key is string => Boolean(key))
              .filter((key) =>
                new RegExp(`^${platform}/[^/]+/update\\.json$`).test(key),
              );
            keys.push(...platformKeys);
            continuationToken = response.NextContinuationToken;
          } while (continuationToken);

          const bundlesForPlatform = await Promise.all(
            keys.map(async (key) => {
              try {
                const command = new GetObjectCommand({
                  Bucket: bucketName,
                  Key: key,
                });
                const { Body } = await client.send(command);
                const bodyContents = await streamToString(Body);

                const bundlesData = JSON.parse(bodyContents) as Bundle[];
                return bundlesData.map((bundle) => ({
                  ...bundle,
                  _updateJsonKey: key,
                }));
              } catch (e) {
                if (e instanceof NoSuchKey) {
                  return [];
                }
                throw e;
              }
            }),
          );
          allBundles.push(...bundlesForPlatform.flat());
        }

        allBundles.sort((a, b) => b.id.localeCompare(a.id));
        bundles = allBundles;

        return bundles;
      },
    };
  };

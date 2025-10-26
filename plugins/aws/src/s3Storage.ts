import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  type BasePluginArgs,
  createStorageKeyBuilder,
  getContentEncoding,
  getContentType,
  type StoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import path from "path";

export interface S3StorageConfig extends S3ClientConfig {
  bucketName: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

export const s3Storage =
  (config: S3StorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    const getStorageKey = createStorageKeyBuilder(config.basePath);

    return {
      name: "s3Storage",
      async deleteBundle(bundleId) {
        const Key = getStorageKey(bundleId, "bundle.zip");

        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: bundleId,
        });
        const listResponse = await client.send(listCommand);

        if (listResponse.Contents && listResponse.Contents.length > 0) {
          const objectsToDelete = listResponse.Contents.map((obj) => ({
            Key: obj.Key,
          }));

          const deleteParams = {
            Bucket: bucketName,
            Delete: {
              Objects: objectsToDelete,
              Quiet: true,
            },
          };

          const deleteCommand = new DeleteObjectsCommand(deleteParams);
          await client.send(deleteCommand);
          return {
            storageUri: `s3://${bucketName}/${Key}`,
          };
        }

        throw new Error("Bundle Not Found");
      },
      async uploadBundle(bundleId, bundlePath) {
        const Body = await fs.readFile(bundlePath);
        const ContentType = getContentType(bundlePath);

        const filename = path.basename(bundlePath);
        const contentEncoding = getContentEncoding(filename);

        const Key = getStorageKey(bundleId, filename);
        const upload = new Upload({
          client,
          params: {
            ContentType,
            Bucket: bucketName,
            Key,
            Body,
            CacheControl: "max-age=31536000",
            ...(contentEncoding && { ContentEncoding: contentEncoding }),
          },
        });
        const response = await upload.done();
        if (!response.Bucket || !response.Key) {
          throw new Error("Upload Failed");
        }

        hooks?.onStorageUploaded?.();
        return {
          storageUri: `s3://${bucketName}/${Key}`,
        };
      },
    };
  };

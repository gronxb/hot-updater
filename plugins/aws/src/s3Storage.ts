import path from "path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";

export interface S3StorageConfig extends S3ClientConfig {
  bucketName: string;
}

export const s3Storage =
  (config: S3StorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    return {
      name: "s3Storage",

      async upload(key: string, filePath: string) {
        const Body = await fs.readFile(filePath);
        const ContentType = mime.getType(filePath) ?? void 0;

        const filename = path.basename(filePath);
        const Key = [key, filename].join("/");

        const upload = new Upload({
          client,
          params: {
            ContentType,
            Bucket: bucketName,
            Key,
            Body,
            CacheControl: "max-age=31536000",
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

      async delete(storageUri: string) {
        // Parse s3://bucket-name/key from storageUri
        const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid S3 storage URI format");
        }

        const [, bucket, key] = match;
        if (bucket !== bucketName) {
          throw new Error(
            "Storage URI bucket does not match configured bucket",
          );
        }

        // For directories, list and delete all objects with the prefix
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: key,
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
        } else {
          throw new Error("File not found in storage");
        }
      },

      async getDownloadUrl(storageUri: string) {
        // Parse s3://bucket-name/key from storageUri
        const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid S3 storage URI format");
        }

        const [, bucket, key] = match;
        if (bucket !== bucketName) {
          throw new Error(
            "Storage URI bucket does not match configured bucket",
          );
        }

        // If key represents a directory prefix, find the actual file
        let actualKey = key;
        if (!key.includes(".")) {
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: key,
          });
          const listResponse = await client.send(listCommand);

          if (!listResponse.Contents || listResponse.Contents.length === 0) {
            throw new Error("File not found in storage");
          }

          const firstObject = listResponse.Contents[0];
          if (!firstObject.Key) {
            throw new Error("Invalid storage object");
          }
          actualKey = firstObject.Key;
        }

        const command = new GetObjectCommand({
          Bucket: bucketName,
          Key: actualKey,
        });

        // Generate signed URL valid for 1 hour
        const signedUrl = await getSignedUrl(
          client as unknown as Parameters<typeof getSignedUrl>[0],
          command,
          { expiresIn: 3600 },
        );

        return {
          fileUrl: signedUrl,
        };
      },
    };
  };

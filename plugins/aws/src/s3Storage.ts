import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  createStorageKeyBuilder,
  getContentType,
  parseStorageUri,
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
  (): StoragePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    const getStorageKey = createStorageKeyBuilder(config.basePath);

    return {
      name: "s3Storage",
      supportedProtocol: "s3",
      async delete(storageUri) {
        const { bucket, key } = parseStorageUri(storageUri, "s3");
        if (bucket !== bucketName) {
          throw new Error(
            `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
          );
        }

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
          return;
        }

        throw new Error("Bundle Not Found");
      },
      async upload(key, filePath) {
        const Body = await fs.readFile(filePath);
        const ContentType = getContentType(filePath);

        const filename = path.basename(filePath);

        const Key = getStorageKey(key, filename);
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
      async getDownloadUrl(storageUri: string) {
        // Simple validation: supported protocol must match
        const u = new URL(storageUri);
        if (u.protocol.replace(":", "") !== "s3") {
          throw new Error("Invalid S3 storage URI protocol");
        }
        const bucket = u.host;
        const key = u.pathname.slice(1);
        if (!bucket || !key) {
          throw new Error("Invalid S3 storage URI: missing bucket or key");
        }
        try {
          const command = new GetObjectCommand({ Bucket: bucket, Key: key });
          const signedUrl = await getSignedUrl(client as any, command as any, {
            expiresIn: 3600,
          });
          if (!signedUrl) throw new Error("Failed to presign S3 URL");
          return { fileUrl: signedUrl };
        } catch (e) {
          throw new Error(
            e instanceof Error
              ? `Failed to presign S3 URL: ${e.message}`
              : "Failed to presign S3 URL",
          );
        }
      },
    };
  };

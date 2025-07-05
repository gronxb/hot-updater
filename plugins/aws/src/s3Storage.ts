import path from "path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
  GetObjectCommand,
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
      async deleteBundle(bundleId) {
        const Key = bundleId;

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
        const ContentType = mime.getType(bundlePath) ?? void 0;

        const filename = path.basename(bundlePath);

        const Key = [bundleId, filename].join("/");
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

      // Native build operations
      async uploadNativeBuild(nativeBuildId, nativeBuildPath) {
        const Body = await fs.readFile(nativeBuildPath);
        const ContentType = mime.getType(nativeBuildPath) ?? void 0;

        const filename = path.basename(nativeBuildPath);
        
        // Store native builds in a separate folder structure
        const Key = ["native-builds", nativeBuildId, filename].join("/");
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
          throw new Error("Native build upload failed");
        }

        hooks?.onStorageUploaded?.();
        return {
          storageUri: `s3://${bucketName}/${Key}`,
        };
      },

      async deleteNativeBuild(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;

        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
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
            storageUri: `s3://${bucketName}/${prefix}`,
          };
        }

        throw new Error("Native build not found");
      },

      async getNativeBuildDownloadUrl(nativeBuildId) {
        // List objects to find the actual file
        const prefix = `native-builds/${nativeBuildId}`;
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
        });
        const listResponse = await client.send(listCommand);

        if (!listResponse.Contents || listResponse.Contents.length === 0) {
          throw new Error("Native build not found");
        }

        // Get the first file (should be the native build artifact)
        const firstObject = listResponse.Contents[0];
        if (!firstObject.Key) {
          throw new Error("Invalid native build object");
        }

        const command = new GetObjectCommand({
          Bucket: bucketName,
          Key: firstObject.Key,
        });

        // Generate signed URL valid for 1 hour
        // AWS SDK types have compatibility issues, but the runtime works correctly
        const signedUrl = await getSignedUrl(client as unknown as Parameters<typeof getSignedUrl>[0], command, { expiresIn: 3600 });
        
        return {
          fileUrl: signedUrl,
        };
      },
    };
  };

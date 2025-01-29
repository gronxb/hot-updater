import path from "path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";

import Cloudflare from "cloudflare";

export interface R2StorageConfig {
  cloudflareApiToken: string;
  accountId: string;
  bucketName: string;
  accessKeyId: string;
}

export const r2Storage =
  (config: R2StorageConfig, hooks?: StoragePluginHooks) =>
  async (_: BasePluginArgs): Promise<StoragePlugin> => {
    const { bucketName } = config;
    const cf = new Cloudflare({
      apiToken: config.cloudflareApiToken,
    });

    const credentials = await cf.r2.temporaryCredentials.create({
      account_id: config.accountId,
      bucket: config.bucketName,
      ttlSeconds: 60 * 10, // 10 minutes
      parentAccessKeyId: config.accessKeyId,
      permission: "object-read-write",
    });

    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new Error("Failed to create temporary credentials");
    }

    const client = new S3Client({
      region: "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    });

    return {
      name: "r2Storage",
      async deleteBundle(bundleId) {
        const Key = [bundleId].join("/");

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
          return Key;
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
          },
        });
        const response = await upload.done();
        if (!response.Location || !response.Key) {
          throw new Error("Upload Failed");
        }

        hooks?.onStorageUploaded?.();
        return {
          fileUrl: hooks?.transformFileUrl?.(response.Key) ?? response.Location,
        };
      },
    };
  };

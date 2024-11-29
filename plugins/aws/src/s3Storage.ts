import path from "path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  BasePluginArgs,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";

export interface S3StorageConfig
  extends Pick<S3ClientConfig, "credentials" | "region"> {
  bucketName: string;
}

export const s3Storage =
  (config: S3StorageConfig) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    return {
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
        if (!response.Location) {
          throw new Error("Upload Failed");
        }

        return {
          file: response.Location,
        };
      },
    };
  };

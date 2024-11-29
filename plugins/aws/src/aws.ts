import path from "path";
import {
  DeleteObjectsCommand,
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
  DeployPlugin,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";
import { streamToString } from "./utils/streamToString";

export interface AwsConfig
  extends Pick<S3ClientConfig, "credentials" | "region"> {
  bucketName: string;
}

export const aws =
  (config: AwsConfig) =>
  (_: BasePluginArgs): DeployPlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    let bundles: Bundle[] = [];

    return {
      async commitBundle() {
        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          await client.send(command);
        } catch (e) {
          if (!(e instanceof NoSuchKey)) {
            throw e;
          }
        }

        const Key = "update.json";
        const Body = JSON.stringify(bundles);
        const ContentType = mime.getType(Key) ?? void 0;

        const upload = new Upload({
          client,
          params: {
            ContentType,
            Bucket: bucketName,
            Key,
            Body,
          },
        });
        await upload.done();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
      },
      async setBundles(inputBundles) {
        bundles = inputBundles;
      },

      async getBundles(refresh = false) {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          const { Body: UpdateJsonBody } = await client.send(command);
          const bodyContents = await streamToString(UpdateJsonBody);
          const _bundle = JSON.parse(bodyContents);
          bundles = _bundle;
          return _bundle as Bundle[];
        } catch (e) {
          if (e instanceof NoSuchKey) {
            return [];
          }
          throw e;
        }
      },
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

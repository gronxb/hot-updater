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
  DeployPlugin,
  UpdateSource,
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
  ({ log, spinner }: BasePluginArgs): DeployPlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    let updateSources: UpdateSource[] = [];

    return {
      async commitUpdateSource() {
        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          await client.send(command);
        } catch (e) {
          if (e instanceof NoSuchKey) {
            spinner?.message("Creating new update.json");
          } else {
            throw e;
          }
        }

        spinner?.message("Uploading update.json");
        const Key = "update.json";
        const Body = JSON.stringify(updateSources);
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
      async updateUpdateSource(
        targetBundleVersion: number,
        newSource: Partial<UpdateSource>,
      ) {
        updateSources = await this.getUpdateSources();

        const targetIndex = updateSources.findIndex(
          (u) => u.bundleVersion === targetBundleVersion,
        );
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(updateSources[targetIndex], newSource);
      },
      async appendUpdateSource(source) {
        updateSources = await this.getUpdateSources();
        updateSources.unshift(source);
      },
      async setUpdateSources(sources) {
        updateSources = sources;
      },

      async getUpdateSources(refresh = false) {
        if (updateSources.length > 0 && !refresh) {
          return updateSources;
        }

        spinner?.message("Getting update.json");

        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          const { Body: UpdateJsonBody } = await client.send(command);
          const bodyContents = await streamToString(UpdateJsonBody);
          const _updateSource = JSON.parse(bodyContents);
          updateSources = _updateSource;
          return _updateSource as UpdateSource[];
        } catch (e) {
          if (e instanceof NoSuchKey) {
            return [];
          }
          throw e;
        }
      },
      async deleteBundle(platform, bundleVersion) {
        const Key = [bundleVersion, platform].join("/");

        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: `${bundleVersion}/${platform}`,
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

        spinner?.error("Bundle Not Found");
        throw new Error("Bundle Not Found");
      },
      async uploadBundle(platform, bundleVersion, bundlePath) {
        spinner?.message("Uploading Bundle");

        const Body = await fs.readFile(bundlePath);
        const ContentType = mime.getType(bundlePath) ?? void 0;

        const filename = path.basename(bundlePath);

        const Key = [bundleVersion, platform, filename].join("/");
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
          spinner?.error("Upload Failed");
          throw new Error("Upload Failed");
        }

        log?.info(`Uploaded: ${Key}`);
        return {
          file: response.Location,
        };
      },
    };
  };

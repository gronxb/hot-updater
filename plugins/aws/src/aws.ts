import fs from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  CliArgs,
  DeployPlugin,
  UpdateSource,
} from "@hot-updater/internal";
import mime from "mime";
import { readDir } from "./utils/readDir";
import { streamToString } from "./utils/streamToString";

export interface AwsConfig
  extends Pick<S3ClientConfig, "credentials" | "region"> {
  bucketName: string;
}

export const aws =
  (config: AwsConfig) =>
  ({ cwd, platform, spinner }: CliArgs): DeployPlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    const buildDir = path.join(cwd, "build");

    let files: string[] = [];
    let updateSources: UpdateSource[] = [];

    return {
      async commitUpdateJson() {
        if (updateSources.length === 0) {
          return;
        }

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

        spinner?.message("uploading update.json");
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
      async updateUpdateJson(
        targetBundleVersion: number,
        newSource: UpdateSource,
      ) {
        updateSources = await this.getUpdateJson();

        const targetIndex = updateSources.findIndex(
          (u) => u.bundleVersion === targetBundleVersion,
        );
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        updateSources[targetIndex] = newSource;
      },
      async appendUpdateJson(source) {
        updateSources = await this.getUpdateJson();
        updateSources.unshift(source);
      },

      async getUpdateJson(refresh = false) {
        if (updateSources.length > 0 && !refresh) {
          return updateSources;
        }

        spinner?.message("getting update.json");

        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          const { Body: UpdateJsonBody } = await client.send(command);
          const bodyContents = await streamToString(UpdateJsonBody);
          const updateJson = JSON.parse(bodyContents);
          updateSources = updateJson;
          return updateJson as UpdateSource[];
        } catch (e) {
          if (e instanceof NoSuchKey) {
            return [];
          }
          throw e;
        }
      },
      async uploadBundle(bundleVersion) {
        spinner?.message("uploading to s3");

        const buildFiles = await readDir(buildDir);
        const result = await Promise.allSettled(
          buildFiles.map(async (file) => {
            const filePath = path.join(buildDir, file);
            const Body = await fs.readFile(filePath);
            const ContentType = mime.getType(filePath) ?? void 0;

            const Key = [
              `${bundleVersion}`,
              platform,
              file.replace(buildDir, ""),
            ].join("/");
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
            spinner?.message(`uploaded: ${Key}`);
            return response.Location;
          }),
        );

        const rejectedCount = result.filter(
          (r) => r.status === "rejected",
        ).length;
        if (rejectedCount > 0) {
          throw new Error("upload failed");
        }

        files = result
          .map((r) => r.status === "fulfilled" && r.value)
          .filter(Boolean) as string[];

        return { files };
      },
    };
  };

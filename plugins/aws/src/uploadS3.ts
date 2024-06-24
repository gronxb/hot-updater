import fs from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  type CliArgs,
  type DeployPlugin,
  type UpdateSource,
  log,
} from "@hot-updater/internal";
import mime from "mime";
import { readDir } from "./utils/readDir";
import { streamToString } from "./utils/streamToString";

export interface AwsConfig
  extends Pick<S3ClientConfig, "credentials" | "region"> {
  bucketName: string;
}

export const uploadS3 =
  (config: AwsConfig) =>
  ({ cwd, platform }: CliArgs): DeployPlugin => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    const buildDir = path.join(cwd, "build");

    let files: string[] = [];

    return {
      async uploadUpdateJson(source) {
        log.info("uploading update.json");

        const newUpdateJson: UpdateSource[] = [];
        try {
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: "update.json",
          });
          const { Body: UpdateJsonBody } = await client.send(command);
          const bodyContents = await streamToString(UpdateJsonBody);
          const updateJson = JSON.parse(bodyContents);
          newUpdateJson.push(...updateJson);
        } catch (e) {
          if (e instanceof NoSuchKey) {
            log.info("update.json not found creating new one");
          } else {
            throw e;
          }
        }
        newUpdateJson.unshift(source);

        const Key = "update.json";
        const Body = JSON.stringify(newUpdateJson, null, 2);
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
      async uploadBundle(bundleVersion) {
        log.info("uploading to s3");

        const buildFiles = await readDir(buildDir);
        const result = await Promise.allSettled(
          buildFiles.map(async (file) => {
            const filePath = path.join(buildDir, file);
            const Body = await fs.readFile(filePath);
            const ContentType = mime.getType(filePath) ?? void 0;

            const Key = [
              `v${bundleVersion}`,
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
            log.info(`uploaded: ${Key}`);
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

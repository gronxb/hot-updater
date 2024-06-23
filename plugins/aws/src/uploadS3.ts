import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { readDir } from "./utils/readDir";

export interface AwsConfig
  extends Pick<S3ClientConfig, "credentials" | "region"> {
  bucketName: string;
}

export const uploadS3 =
  (config: AwsConfig) =>
  ({ cwd, platform }: { platform: "ios" | "android"; cwd: string }) => {
    const { bucketName, ...s3Config } = config;
    const client = new S3Client(s3Config);

    const buildDir = path.join(cwd, "build");

    return {
      async upload() {
        console.log("uploading to s3");

        const files = await readDir(buildDir);
        const result = await Promise.allSettled(
          files.map(async (file, index) => {
            const Body = await fs.readFile(path.join(buildDir, file));
            const Key = ["v1_TEST", platform, file.replace(buildDir, "")].join(
              "/",
            );
            const upload = new Upload({
              client,
              params: {
                Bucket: bucketName,
                Key,
                Body,
              },
            });
            await upload.done();

            console.log(`uploaded: ${Key}`);
            return upload;
          }),
        );

        const rejectedCount = result.filter(
          (r) => r.status === "rejected",
        ).length;
        if (rejectedCount > 0) {
          throw new Error("upload failed");
        }
      },
    };
  };

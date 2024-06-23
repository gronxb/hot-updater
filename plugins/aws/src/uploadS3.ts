import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { type CliArgs, type DeployPlugin, log } from "@hot-updater/internal";
import mime from "mime";
import { readDir } from "./utils/readDir";

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

    return {
      readStrategy: {
        getListObjects: async (prefix) => {
          // s3에 있는 파일 목록 가져오기
          // prefix가 있으면 prefix로 시작하는 파일만 가져오기
          // 없으면 모두 가져오기
          return [];
        },
      },
      async uploadUpdateJson() {
        // s3에 metadata.json 이미 있나 확인하기
        // 있으면 secretKey로 열어보기
        // 없으면 만들기
        // 다음 버전 만들기
        // {
        //   "1.0": [
        //     {
        //       files: [],
        //       forceUpdate: false,
        //       enabled: true,
        //       bundleVersion: 5, // Higher than the current version
        //     },
        //     {
        //       files: [],
        //       forceUpdate: false,
        //       enabled: true,
        //       bundleVersion: 4,
        //     },
        //     {
        //       files: [],
        //       forceUpdate: false,
        //       enabled: true,
        //       bundleVersion: 3,
        //     },
        //     {
        //       files: [],
        //       forceUpdate: false,
        //       enabled: true,
        //       bundleVersion: 2,
        //     },
        //     {
        //       files: [],
        //       forceUpdate: false,
        //       enabled: true,
        //       bundleVersion: 1,
        //     },
        //   ],
        // }
      },
      async uploadBundle() {
        log.info("uploading to s3");

        const files = await readDir(buildDir);
        const result = await Promise.allSettled(
          files.map(async (file, index) => {
            const filePath = path.join(buildDir, file);
            const Body = await fs.readFile(filePath);
            const ContentType = mime.getType(filePath) ?? void 0;

            const Key = ["v1_TEST", platform, file.replace(buildDir, "")].join(
              "/",
            );
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
            return upload;
          }),
        );

        const rejectedCount = result.filter(
          (r) => r.status === "rejected",
        ).length;
        if (rejectedCount > 0) {
          throw new Error("upload failed");
        }
        log.success("upload success");
      },
    };
  };

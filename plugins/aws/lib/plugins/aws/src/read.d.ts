import { S3Client } from "@aws-sdk/client-s3";
import type { HotUpdaterReadStrategy } from "@hot-updater/internal";
export interface HotUpdaterAwsOptions {
    s3Client: S3Client;
    bucketName: string;
    baseUrl: string;
}
export declare const aws: ({ baseUrl, bucketName, s3Client, }: HotUpdaterAwsOptions) => HotUpdaterReadStrategy;
export { S3Client };

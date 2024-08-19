import { type S3ClientConfig } from "@aws-sdk/client-s3";
import type { BasePluginArgs, DeployPlugin } from "@hot-updater/internal";
export interface AwsConfig extends Pick<S3ClientConfig, "credentials" | "region"> {
    bucketName: string;
}
export declare const aws: (config: AwsConfig) => ({ log, spinner }: BasePluginArgs) => DeployPlugin;

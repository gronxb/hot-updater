import { type S3ClientConfig } from "@aws-sdk/client-s3";
export interface AwsConfig extends Pick<S3ClientConfig, "credentials" | "region"> {
    bucketName: string;
}
export declare const uploadS3: (config: AwsConfig) => (cwd: string) => {
    upload(): Promise<void>;
};

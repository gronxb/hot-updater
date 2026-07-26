import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { ConfigReference } from "@hot-updater/core/config";

export type Resolvable<TValue> = TValue | ConfigReference;

export type S3CredentialInput = NonNullable<S3ClientConfig["credentials"]>;

export type S3CredentialsConfig =
  | S3CredentialInput
  | Readonly<{
      accessKeyId: Resolvable<string>;
      secretAccessKey: Resolvable<string>;
      sessionToken?: Resolvable<string>;
    }>
  | ConfigReference;

export type S3DownloadDelivery =
  | Readonly<{
      type: "presigned";
      expiresInSeconds?: number;
    }>
  | Readonly<{
      type: "cloudfront";
      publicBaseUrl: Resolvable<string>;
      keyPairId: Resolvable<string>;
      privateKey: Resolvable<string>;
      expiresInSeconds?: number;
    }>;

export type S3StorageConfig = Readonly<{
  bucketName: Resolvable<string>;
  basePath?: Resolvable<string>;
  region?: Resolvable<string>;
  endpoint?: Resolvable<string>;
  credentials?: S3CredentialsConfig;
  forcePathStyle?: boolean;
  maxAttempts?: S3ClientConfig["maxAttempts"];
  requestChecksumCalculation?: S3ClientConfig["requestChecksumCalculation"];
  responseChecksumValidation?: S3ClientConfig["responseChecksumValidation"];
  delivery?: S3DownloadDelivery;
}>;

export type ResolvedS3StorageConfig = Readonly<{
  bucketName: string;
  basePath?: string;
  region?: string;
  endpoint?: string;
  credentials?: S3CredentialInput;
  forcePathStyle?: boolean;
  maxAttempts?: S3ClientConfig["maxAttempts"];
  requestChecksumCalculation?: S3ClientConfig["requestChecksumCalculation"];
  responseChecksumValidation?: S3ClientConfig["responseChecksumValidation"];
  delivery?: Readonly<
    | {
        type: "presigned";
        expiresInSeconds?: number;
      }
    | {
        type: "cloudfront";
        publicBaseUrl: string;
        keyPairId: string;
        privateKey: string;
        expiresInSeconds?: number;
      }
  >;
}>;

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { ConfigReference } from "@hot-updater/core/config";

import type { StringConfigValue } from "./shared";

type R2CredentialValue = StringConfigValue;

export type R2CredentialsConfig =
  | NonNullable<S3ClientConfig["credentials"]>
  | ConfigReference
  | Readonly<{
      accessKeyId: R2CredentialValue;
      secretAccessKey: R2CredentialValue;
      sessionToken?: R2CredentialValue;
    }>;

export type R2NodeStorageConfig = Readonly<{
  accountId: StringConfigValue;
  bucketName: StringConfigValue;
  credentials: R2CredentialsConfig;
  basePath?: StringConfigValue;
  endpoint?: StringConfigValue;
  publicBaseUrl?: StringConfigValue;
  forcePathStyle?: boolean;
  region?: StringConfigValue;
}>;

export type ResolvedR2NodeStorageConfig = Readonly<{
  accountId: string;
  bucketName: string;
  credentials: NonNullable<S3ClientConfig["credentials"]>;
  basePath?: string;
  endpoint: string;
  publicBaseUrl?: string;
  forcePathStyle: boolean;
  region: string;
}>;

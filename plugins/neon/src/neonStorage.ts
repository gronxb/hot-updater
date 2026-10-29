import type { StorageAdapterWith } from "@hot-updater/plugin-core";
import {
  createS3Storage,
  type S3ClientConfig,
  type S3CredentialsOption,
  type S3StorageOperations,
} from "@hot-updater/storage-s3";

export interface NeonStorageConfig extends Omit<
  S3ClientConfig,
  "credentials" | "endpoint" | "forcePathStyle"
> {
  /**
   * The branch's object storage endpoint, such as
   * `https://br-xxx.storage.c-5.us-east-2.aws.neon.tech`: the
   * `AWS_ENDPOINT_URL_S3` that `neon env pull` writes.
   */
  endpoint: string;
  /** The bucket on that branch. */
  bucketName: string;
  /**
   * A storage credential of the project: the `AWS_ACCESS_KEY_ID` and
   * `AWS_SECRET_ACCESS_KEY` that `neon env pull` writes. Each field may be
   * lazy, such as `secret("<name>")` in `hot-updater.config.ts`.
   */
  credentials: NonNullable<S3CredentialsOption>;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /**
   * Lifetime of the download URLs in seconds, at most seven days, the
   * SigV4 limit. @default 3600
   */
  signedUrlExpiresIn?: number;
}

/** The endpoint's origin, or an error that names the variable to set. */
const endpointOrigin = (endpoint: string) => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      "neonStorage needs the branch's storage endpoint (AWS_ENDPOINT_URL_S3), such as https://br-xxx.storage.c-5.us-east-2.aws.neon.tech.",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `neonStorage endpoint must not include a path: pass the bucket as bucketName instead of "${url.pathname}".`,
    );
  }
  return url.origin;
};

/**
 * Bundles in a Neon Object Storage bucket, through its S3 API. Devices
 * download from presigned URLs that expire, so a private bucket works.
 */
export const neonStorage = (
  config: NeonStorageConfig,
): StorageAdapterWith<S3StorageOperations> => {
  const { endpoint, region, ...s3Config } = config;
  return createS3Storage(
    { name: "neonStorage", protocol: "neon" },
    {
      ...s3Config,
      endpoint: endpointOrigin(endpoint),
      // Neon serves buckets at a path of the branch's host only.
      forcePathStyle: true,
      // Neon accepts a signature for any region.
      region: region ?? "us-east-1",
    },
  );
};

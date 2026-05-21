import fs from "node:fs/promises";
import path from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  createStorageKeyBuilder,
  getContentType,
  type NodeStorageProfile,
  parseStorageUri,
} from "@hot-updater/plugin-core";

export interface R2S3StorageConfig extends S3ClientConfig {
  accountId: string;
  bucketName: string;
  credentials: NonNullable<S3ClientConfig["credentials"]>;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

const ensureExpectedR2Bucket = (bucket: string, bucketName: string) => {
  if (bucket !== bucketName) {
    throw new Error(
      `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
    );
  }
};

const isS3ObjectNotFoundError = (error: unknown) => {
  if (error instanceof Error) {
    return error.name === "NotFound" || error.name === "NoSuchKey";
  }

  if (typeof error === "object" && error !== null && "$metadata" in error) {
    return (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404
    );
  }

  return false;
};

const createS3Client = (config: R2S3StorageConfig) => {
  const {
    accountId,
    basePath: _basePath,
    bucketName: _bucketName,
    endpoint,
    forcePathStyle,
    region,
    ...s3Config
  } = config;

  return new S3Client({
    ...s3Config,
    endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: forcePathStyle ?? true,
    region: region ?? "auto",
  });
};

export const createS3StorageProfile = (
  config: R2S3StorageConfig,
): NodeStorageProfile => {
  const { bucketName } = config;
  const client = createS3Client(config);
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  return {
    async delete(storageUri) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

      await client.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
      );
    },
    async upload(key, filePath) {
      const Body = await fs.readFile(filePath);
      const ContentType = getContentType(filePath);
      const filename = path.basename(filePath);
      const Key = getStorageKey(key, filename);

      const upload = new Upload({
        client,
        params: {
          Body,
          Bucket: bucketName,
          CacheControl: "max-age=31536000",
          ContentType,
          Key,
        },
      });
      await upload.done();

      return {
        storageUri: `r2://${bucketName}/${Key}`,
      };
    },
    async exists(storageUri: string) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucketName, Key: key }),
        );
        return true;
      } catch (error) {
        if (isS3ObjectNotFoundError(error)) {
          return false;
        }

        throw error;
      }
    },
    async downloadFile(storageUri, filePath) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

      const response = await client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
      );

      if (!response.Body) {
        throw new Error("R2 object body is empty");
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, await response.Body.transformToByteArray());
    },
  };
};

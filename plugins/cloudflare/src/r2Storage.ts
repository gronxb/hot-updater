import fs from "node:fs/promises";
import os from "node:os";
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
  createNodeStoragePlugin,
  getContentType,
  type NodeStorageProfile,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import { createWrangler } from "./utils/createWrangler";

export interface R2StorageConfig extends S3ClientConfig {
  cloudflareApiToken?: string;
  accountId: string;
  bucketName: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

const isR2ObjectNotFoundError = (error: ExecaError) => {
  const output = [error.stderr, error.stdout, error.shortMessage, error.message]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return (
    output.includes("not found") ||
    output.includes("no such object") ||
    output.includes("does not exist")
  );
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

const ensureExpectedBucket = (bucket: string, bucketName: string) => {
  if (bucket !== bucketName) {
    throw new Error(
      `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
    );
  }
};

const createS3Client = (config: R2StorageConfig) => {
  const {
    accountId,
    basePath: _basePath,
    bucketName: _bucketName,
    cloudflareApiToken: _cloudflareApiToken,
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

const createS3StorageProfile = (
  config: R2StorageConfig,
): NodeStorageProfile => {
  const { bucketName } = config;
  const client = createS3Client(config);
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  return {
    async delete(storageUri) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedBucket(bucket, bucketName);

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
      ensureExpectedBucket(bucket, bucketName);

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
      ensureExpectedBucket(bucket, bucketName);

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

const createWranglerStorageProfile = (
  config: R2StorageConfig,
): NodeStorageProfile => {
  const { bucketName, cloudflareApiToken, accountId } = config;
  if (!cloudflareApiToken) {
    throw new Error(
      "r2Storage requires either R2 S3 credentials or cloudflareApiToken.",
    );
  }

  const wrangler = createWrangler({
    accountId,
    cloudflareApiToken,
    cwd: process.cwd(),
  });
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  return {
    async delete(storageUri) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedBucket(bucket, bucketName);

      try {
        await wrangler(
          "r2",
          "object",
          "delete",
          [bucketName, key].join("/"),
          "--remote",
        );
      } catch {
        throw new Error("Can not delete bundle");
      }
    },
    async upload(key, filePath) {
      const contentType = getContentType(filePath);

      const filename = path.basename(filePath);

      const Key = getStorageKey(key, filename);
      try {
        const { stderr, exitCode } = await wrangler(
          "r2",
          "object",
          "put",
          [bucketName, Key].join("/"),
          "--file",
          filePath,
          "--content-type",
          contentType,
          "--remote",
        );
        if (exitCode !== 0 && stderr) {
          throw new Error(stderr);
        }
      } catch (error) {
        if (error instanceof ExecaError) {
          throw new Error(error.stderr || error.stdout);
        }

        throw error;
      }

      return {
        storageUri: `r2://${bucketName}/${Key}`,
      };
    },
    async exists(storageUri: string) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedBucket(bucket, bucketName);

      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-r2-exists-"),
      );
      const tempFilePath = path.join(tempDir, "object");

      try {
        await wrangler(
          "r2",
          "object",
          "get",
          [bucketName, key].join("/"),
          "--file",
          tempFilePath,
          "--remote",
        );
        return true;
      } catch (error) {
        if (error instanceof ExecaError && isR2ObjectNotFoundError(error)) {
          return false;
        }

        throw error;
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }
    },
    async downloadFile(storageUri, filePath) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedBucket(bucket, bucketName);

      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const { stderr, exitCode } = await wrangler(
          "r2",
          "object",
          "get",
          [bucketName, key].join("/"),
          "--file",
          filePath,
          "--remote",
        );
        if (exitCode !== 0 && stderr) {
          throw new Error(stderr);
        }
      } catch (error) {
        if (error instanceof ExecaError) {
          throw new Error(error.stderr || error.stdout);
        }

        throw error;
      }
    },
  };
};

/**
 * Cloudflare R2 storage plugin for Hot Updater.
 */
export const r2Storage = createNodeStoragePlugin<R2StorageConfig>({
  name: "r2Storage",
  supportedProtocol: "r2",
  factory: (config) => {
    if (config.credentials) {
      return createS3StorageProfile(config);
    }

    return createWranglerStorageProfile(config);
  },
});

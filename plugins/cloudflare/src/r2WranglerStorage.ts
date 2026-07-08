import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createStorageKeyBuilder,
  getContentType,
  parseStorageUri,
  type StoragePluginCore,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import { createWrangler } from "./utils/createWrangler";

/**
 * @deprecated `cloudflareApiToken` uses the Wrangler CLI for R2 operations,
 * which is slower than direct S3-compatible API access. Create R2
 * S3-compatible credentials in the Cloudflare dashboard and pass them with
 * `r2Storage({ credentials })` instead.
 */
export interface R2WranglerStorageConfig {
  accountId: string;
  bucketName: string;
  /**
   * @deprecated This token keeps R2 access on the slower Wrangler CLI path.
   * Create R2 S3-compatible credentials in the Cloudflare dashboard and use
   * `credentials` instead.
   */
  cloudflareApiToken: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
  credentials?: never;
}

const ensureExpectedR2Bucket = (bucket: string, bucketName: string) => {
  if (bucket !== bucketName) {
    throw new Error(
      `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
    );
  }
};

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

export const createWranglerStorageOperations = (
  config: R2WranglerStorageConfig,
): Pick<StoragePluginCore, "delete" | "downloadFile" | "exists" | "upload"> => {
  const { bucketName, cloudflareApiToken, accountId } = config;
  const wrangler = createWrangler({
    accountId,
    cloudflareApiToken,
    cwd: process.cwd(),
  });
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  return {
    async delete({ storageUri }) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

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
    async upload({ key, source }) {
      if (source.kind !== "file") {
        throw new Error(
          "This storage plugin only supports file upload sources.",
        );
      }
      const filePath = source.filePath;
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
    async exists({ storageUri }) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

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
    async downloadFile({ storageUri, filePath }) {
      const { bucket, key } = parseStorageUri(storageUri, "r2");
      ensureExpectedR2Bucket(bucket, bucketName);

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

export const createWranglerRuntimeStorageOperations = (): Pick<
  StoragePluginCore,
  "getDownloadUrl" | "readText"
> => {
  const error = new Error(
    "r2Storage runtime operations require R2 S3 credentials. Wrangler-based R2 access is only supported for deploy-time file operations.",
  );

  return {
    async readText() {
      throw error;
    },
    async getDownloadUrl() {
      throw error;
    },
  };
};

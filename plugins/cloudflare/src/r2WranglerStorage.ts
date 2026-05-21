import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createStorageKeyBuilder,
  getContentType,
  type NodeStorageProfile,
  parseStorageUri,
  type RuntimeStorageProfile,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import { createWrangler } from "./utils/createWrangler";

/**
 * @deprecated Use R2 S3 API credentials with `r2Storage({ credentials })`
 * instead of Wrangler-based R2 access.
 */
export interface R2WranglerStorageConfig {
  accountId: string;
  bucketName: string;
  /**
   * @deprecated Use R2 S3 API credentials with `r2Storage({ credentials })`
   * instead of Wrangler-based R2 access.
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

export const createWranglerStorageProfile = (
  config: R2WranglerStorageConfig,
): NodeStorageProfile => {
  const { bucketName, cloudflareApiToken, accountId } = config;
  const wrangler = createWrangler({
    accountId,
    cloudflareApiToken,
    cwd: process.cwd(),
  });
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  return {
    async delete(storageUri) {
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
    async downloadFile(storageUri, filePath) {
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

export const createWranglerRuntimeStorageProfile =
  (): RuntimeStorageProfile => {
    const error = new Error(
      "r2Storage runtime profile requires R2 S3 credentials. Wrangler-based R2 access is only supported by the node profile.",
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

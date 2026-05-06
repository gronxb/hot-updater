import fs from "node:fs/promises";
import path from "node:path";

import {
  createStorageKeyBuilder,
  createNodeStoragePlugin,
  getContentType,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import { createWrangler } from "./utils/createWrangler";

export interface R2StorageConfig {
  cloudflareApiToken: string;
  accountId: string;
  bucketName: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

/**
 * Cloudflare R2 storage plugin for Hot Updater.
 */
export const r2Storage = createNodeStoragePlugin<R2StorageConfig>({
  name: "r2Storage",
  supportedProtocol: "r2",
  factory: (config) => {
    const { bucketName, cloudflareApiToken, accountId } = config;
    const wrangler = createWrangler({
      accountId,
      cloudflareApiToken: cloudflareApiToken,
      cwd: process.cwd(),
    });

    const getStorageKey = createStorageKeyBuilder(config.basePath);

    return {
      async delete(storageUri) {
        const { bucket, key } = parseStorageUri(storageUri, "r2");
        if (bucket !== bucketName) {
          throw new Error(
            `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
          );
        }

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
      async downloadFile(storageUri, filePath) {
        const { bucket, key } = parseStorageUri(storageUri, "r2");
        if (bucket !== bucketName) {
          throw new Error(
            `Bucket name mismatch: expected "${bucketName}", but found "${bucket}".`,
          );
        }

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
  },
});

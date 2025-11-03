import {
  type BasePluginArgs,
  createStorageKeyBuilder,
  getContentType,
  parseStorageUri,
  type StoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import path from "path";
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
 *
 * Note: This plugin does not support `getDownloadUrl()`.
 * If you need download URL generation, use `s3Storage` from `@hot-updater/aws` instead,
 * which is fully compatible with Cloudflare R2.
 *
 * @example
 * ```typescript
 * // Using s3Storage with Cloudflare R2 for download URL support
 * import { s3Storage } from "@hot-updater/aws";
 *
 * s3Storage({
 *   region: "auto",
 *   endpoint: "https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: {
 *     accessKeyId: "YOUR_ACCESS_KEY_ID",
 *     secretAccessKey: "YOUR_SECRET_ACCESS_KEY",
 *   },
 *   bucketName: "YOUR_BUCKET_NAME",
 * })
 * ```
 */
export const r2Storage =
  (config: R2StorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName, cloudflareApiToken, accountId } = config;
    const wrangler = createWrangler({
      accountId,
      cloudflareApiToken: cloudflareApiToken,
      cwd: process.cwd(),
    });

    const getStorageKey = createStorageKeyBuilder(config.basePath);

    return {
      name: "r2Storage",
      supportedProtocol: "r2",
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

        hooks?.onStorageUploaded?.();

        return {
          storageUri: `r2://${bucketName}/${Key}`,
        };
      },
      async getDownloadUrl() {
        throw new Error(
          "`r2Storage` does not support `getDownloadUrl()`. Use `s3Storage` from `@hot-updater/aws` instead (compatible with Cloudflare R2).\n\n" +
            "Example:\n" +
            "s3Storage({\n" +
            "  region: 'auto',\n" +
            "  endpoint: 'https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com',\n" +
            "  credentials: {\n" +
            "    accessKeyId: 'YOUR_ACCESS_KEY_ID',\n" +
            "    secretAccessKey: 'YOUR_SECRET_ACCESS_KEY',\n" +
            "  },\n" +
            "  bucketName: 'YOUR_BUCKET_NAME',\n" +
            "})",
        );
      },
    };
  };

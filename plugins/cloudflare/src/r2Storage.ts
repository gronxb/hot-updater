import {
  type BasePluginArgs,
  createStorageKeyBuilder,
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
      async deleteBundle(bundleId) {
        const Key = getStorageKey(bundleId, "bundle.zip");
        try {
          await wrangler(
            "r2",
            "object",
            "delete",
            [bucketName, Key].join("/"),
            "--remote",
          );

          return {
            storageUri: `r2://${bucketName}/${Key}`,
          };
        } catch {
          throw new Error("Can not delete bundle");
        }
      },
      async uploadBundle(bundleId, bundlePath) {
        const contentType = getContentType(bundlePath);

        const filename = path.basename(bundlePath);

        const Key = getStorageKey(bundleId, filename);
        try {
          const { stderr, exitCode } = await wrangler(
            "r2",
            "object",
            "put",
            [bucketName, Key].join("/"),
            "--file",
            bundlePath,
            "--content-type",
            contentType,
            ...(contentEncoding ? ["--content-encoding", contentEncoding] : []),
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
    };
  };

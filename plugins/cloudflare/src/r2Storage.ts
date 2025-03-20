import path from "path";
import { createWrangler } from "./utils/createWrangler";

import mime from "mime";

import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";

import Cloudflare from "cloudflare";
import { ExecaError } from "execa";

export interface R2StorageConfig {
  cloudflareApiToken: string;
  accountId: string;
  bucketName: string;
}

export const r2Storage =
  (config: R2StorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName, cloudflareApiToken, accountId } = config;
    const cf = new Cloudflare({
      apiToken: cloudflareApiToken,
    });
    const wrangler = createWrangler({
      accountId,
      cloudflareApiToken: cloudflareApiToken,
      cwd: process.cwd(),
    });

    return {
      name: "r2Storage",
      async deleteBundle(bundleId) {
        await wrangler(
          "r2",
          "object",
          "delete",
          [bucketName, bundleId].join("/"),
          "--remote",
        );

        throw new Error("Bundle Not Found");
      },
      async uploadBundle(bundleId, bundlePath) {
        const contentType = mime.getType(bundlePath) ?? void 0;

        const filename = path.basename(bundlePath);

        const Key = [bundleId, filename].join("/");

        try {
          const { stderr } = await wrangler(
            "r2",
            "object",
            "put",
            [bucketName, Key].join("/"),
            "--file",
            bundlePath,
            ...(contentType ? ["--content-type", contentType] : []),
            "--remote",
          );
          if (stderr) {
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
          bucketName,
          key: Key,
        };
      },
    };
  };

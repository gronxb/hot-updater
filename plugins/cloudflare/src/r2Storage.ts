import path from "path";
import { createWrangler } from "./utils/createWrangler";

import mime from "mime";

import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";

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
    const wrangler = createWrangler({
      accountId,
      cloudflareApiToken: cloudflareApiToken,
      cwd: process.cwd(),
    });

    return {
      name: "r2Storage",

      async upload(key: string, filePath: string) {
        const contentType = mime.getType(filePath) ?? void 0;
        const filename = path.basename(filePath);
        const Key = [key, filename].join("/");

        try {
          const { stderr, exitCode } = await wrangler(
            "r2",
            "object",
            "put",
            [bucketName, Key].join("/"),
            "--file",
            filePath,
            ...(contentType ? ["--content-type", contentType] : []),
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

      async delete(storageUri: string) {
        // Parse r2://bucket-name/key from storageUri
        const match = storageUri.match(/^r2:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid R2 storage URI format");
        }

        const [, bucket, key] = match;
        if (bucket !== bucketName) {
          throw new Error(
            "Storage URI bucket does not match configured bucket",
          );
        }

        try {
          // List objects to find all files with the prefix
          const { stdout: listOutput } = await wrangler(
            "r2",
            "object",
            "list",
            bucketName,
            "--prefix",
            key,
            "--remote",
          );

          // Parse the list output to get file names
          const lines = (listOutput || "")
            .split("\n")
            .filter((line) => line.trim());
          const files = lines
            .slice(1) // Skip header
            .map((line) => line.split(/\s+/)[0])
            .filter((name) => name?.startsWith(key));

          if (files.length === 0) {
            throw new Error("File not found in storage");
          }

          // Delete each file
          for (const file of files) {
            await wrangler(
              "r2",
              "object",
              "delete",
              [bucketName, file].join("/"),
              "--remote",
            );
          }
        } catch (error) {
          if (error instanceof ExecaError) {
            throw new Error(
              `Failed to delete file: ${error.stderr || error.stdout}`,
            );
          }
          throw new Error(`Failed to delete file: ${error}`);
        }
      },

      async getDownloadUrl(storageUri: string) {
        // Parse r2://bucket-name/key from storageUri
        const match = storageUri.match(/^r2:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid R2 storage URI format");
        }

        const [, bucket, key] = match;
        if (bucket !== bucketName) {
          throw new Error(
            "Storage URI bucket does not match configured bucket",
          );
        }

        try {
          // If key represents a directory prefix, find the actual file
          let actualKey = key;
          if (!key.includes(".")) {
            const { stdout: listOutput } = await wrangler(
              "r2",
              "object",
              "list",
              bucketName,
              "--prefix",
              key,
              "--remote",
            );

            // Parse the list output to get file names
            const lines = (listOutput || "")
              .split("\n")
              .filter((line) => line.trim());
            const files = lines
              .slice(1) // Skip header
              .map((line) => line.split(/\s+/)[0])
              .filter((name) => name?.startsWith(key));

            if (files.length === 0) {
              throw new Error("File not found in storage");
            }

            actualKey = files[0];
          }

          // Generate presigned URL valid for 1 hour
          const { stdout: urlOutput } = await wrangler(
            "r2",
            "object",
            "presign",
            [bucketName, actualKey].join("/"),
            "--expires-in",
            "3600", // 1 hour in seconds
            "--remote",
          );

          // Extract URL from output
          const signedUrl = (urlOutput || "").trim();

          return {
            fileUrl: signedUrl,
          };
        } catch (error) {
          if (error instanceof ExecaError) {
            throw new Error(
              `Failed to generate download URL: ${error.stderr || error.stdout}`,
            );
          }
          throw new Error(`Failed to generate download URL: ${error}`);
        }
      },
    };
  };

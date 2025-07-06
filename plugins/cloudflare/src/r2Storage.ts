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
      async deleteBundle(bundleId) {
        const Key = `${bundleId}/bundle.zip `;
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
        } catch (error) {
          throw new Error("Can not delete bundle");
        }
      },
      async uploadBundle(bundleId, bundlePath) {
        const contentType = mime.getType(bundlePath) ?? void 0;

        const filename = path.basename(bundlePath);

        const Key = [bundleId, filename].join("/");
        try {
          const { stderr, exitCode } = await wrangler(
            "r2",
            "object",
            "put",
            [bucketName, Key].join("/"),
            "--file",
            bundlePath,
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

      // Native build operations
      async uploadNativeBuild(nativeBuildId, nativeBuildPath) {
        const contentType = mime.getType(nativeBuildPath) ?? void 0;
        const filename = path.basename(nativeBuildPath);
        const Key = `native-builds/${nativeBuildId}/${filename}`;

        try {
          const { stderr, exitCode } = await wrangler(
            "r2",
            "object",
            "put",
            [bucketName, Key].join("/"),
            "--file",
            nativeBuildPath,
            ...(contentType ? ["--content-type", contentType] : []),
            "--remote",
          );
          if (exitCode !== 0 && stderr) {
            throw new Error(stderr);
          }
        } catch (error) {
          if (error instanceof ExecaError) {
            throw new Error(
              `Failed to upload native build: ${error.stderr || error.stdout}`,
            );
          }
          throw new Error(`Failed to upload native build: ${error}`);
        }

        hooks?.onStorageUploaded?.();

        return {
          storageUri: `r2://${bucketName}/${Key}`,
        };
      },

      async deleteNativeBuild(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;

        try {
          // List objects to find all files with the prefix
          const { stdout: listOutput } = await wrangler(
            "r2",
            "object",
            "list",
            bucketName,
            "--prefix",
            prefix,
            "--remote",
          );

          // Parse the list output to get file names
          const lines = (listOutput || "")
            .split("\n")
            .filter((line) => line.trim());
          const files = lines
            .slice(1) // Skip header
            .map((line) => line.split(/\s+/)[0])
            .filter((name) => name && name.startsWith(prefix));

          if (files.length === 0) {
            throw new Error("Native build not found");
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

          return {
            storageUri: `r2://${bucketName}/${prefix}`,
          };
        } catch (error) {
          if (error instanceof ExecaError) {
            throw new Error(
              `Failed to delete native build: ${error.stderr || error.stdout}`,
            );
          }
          throw new Error(`Failed to delete native build: ${error}`);
        }
      },

      async getNativeBuildDownloadUrl(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;

        try {
          // List objects to find the native build file
          const { stdout: listOutput } = await wrangler(
            "r2",
            "object",
            "list",
            bucketName,
            "--prefix",
            prefix,
            "--remote",
          );

          // Parse the list output to get file names
          const lines = (listOutput || "")
            .split("\n")
            .filter((line) => line.trim());
          const files = lines
            .slice(1) // Skip header
            .map((line) => line.split(/\s+/)[0])
            .filter((name) => name && name.startsWith(prefix));

          if (files.length === 0) {
            throw new Error("Native build not found");
          }

          // Get the first file (should be the native build artifact)
          const fileName = files[0];

          // Generate presigned URL valid for 1 hour
          const { stdout: urlOutput } = await wrangler(
            "r2",
            "object",
            "presign",
            [bucketName, fileName].join("/"),
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createStorageKeyBuilder,
  createStoragePlugin,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import { createWrangler } from "./utils/createWrangler";

/**
 * @deprecated Use R2 S3-compatible credentials instead of the Wrangler CLI.
 */
export interface R2WranglerStorageConfig {
  accountId: string;
  bucketName: string;
  cloudflareApiToken: string;
  basePath?: string;
  credentials?: never;
}

const isObjectNotFoundError = (error: ExecaError) =>
  [error.stderr, error.stdout, error.shortMessage, error.message]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .match(/not found|no such object|does not exist/) !== null;

export const createR2WranglerStorage = (
  config: R2WranglerStorageConfig,
): StoragePluginWith<"put" | "get" | "exists" | "delete"> => {
  const { accountId, bucketName, cloudflareApiToken } = config;
  const wrangler = createWrangler({
    accountId,
    cloudflareApiToken,
    cwd: process.cwd(),
  });
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "r2");
    if (parsed.bucket !== bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  const withTempFile = async <T>(
    callback: (filePath: string) => Promise<T>,
  ): Promise<T> => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-r2-"));
    try {
      return await callback(path.join(tempDir, "object"));
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  };

  const getResponse = async (storageUri: string): Promise<Response | null> => {
    const { key } = parseAndValidate(storageUri);
    return withTempFile(async (filePath) => {
      try {
        await wrangler(
          "r2",
          "object",
          "get",
          `${bucketName}/${key}`,
          "--file",
          filePath,
          "--remote",
        );
        return new Response(await fs.readFile(filePath));
      } catch (error) {
        if (error instanceof ExecaError && isObjectNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    });
  };

  return createStoragePlugin({
    name: "r2Storage",
    protocol: "r2",
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      await withTempFile(async (filePath) => {
        await fs.writeFile(filePath, body);
        await wrangler(
          "r2",
          "object",
          "put",
          `${bucketName}/${storageKey}`,
          "--file",
          filePath,
          "--content-type",
          contentType,
          "--remote",
        );
      });
      return { storageUri: `r2://${bucketName}/${storageKey}` };
    },
    async get({ storageUri }) {
      return { response: await getResponse(storageUri) };
    },
    async exists({ storageUri }) {
      return { exists: (await getResponse(storageUri)) !== null };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await wrangler(
        "r2",
        "object",
        "delete",
        `${bucketName}/${key}`,
        "--remote",
      );
      return { storageUri };
    },
  });
};

import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";
import { Storage } from "@google-cloud/storage";

const storage = new Storage();

export interface GCSStorageConfig {
  bucketName: string;
}

export const gcsStorage =
  (config: GCSStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const { bucketName } = config;

    /**
     * Delete a file from GCS
     * @param fileName
     */
    async function deleteBundle(fileName: string) {
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(fileName);
      await file.delete();
      return fileName;
    }

    /**
     * Uploads a file to GCS
     * @param bundleId
     * @param bundlePath
     * @returns
     *  - fileUrl: The URL of the uploaded file
     */
    async function uploadBundle(
      bundleId: string,
      bundlePath: string,
    ): Promise<{ bucketName: string; key: string }> {
      const filename = path.basename(bundlePath);
      const file = storage
        .bucket(bucketName)
        .file([bundleId, filename].join("/"));
      await file.save(await fs.readFile(bundlePath), {
        contentType: mime.getType(bundlePath) ?? void 0,
      });
      hooks?.onStorageUploaded?.();
      return {
        bucketName,
        key: file.name,
      };
    }

    return {
      name: "gcsStorage",
      deleteBundle,
      uploadBundle,
    };
  };

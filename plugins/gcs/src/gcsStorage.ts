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

    return {
      name: "gcsStorage",
      async deleteBundle(bundleId: string) {
        await storage.bucket(bucketName).deleteFiles({
          prefix: bundleId,
        });
      },
      async uploadBundle(bundleId: string, bundlePath: string) {
        const filename = path.basename(bundlePath);

        const file = storage
          .bucket(bucketName)
          .file([bundleId, filename].join("/"));
        await file.save(await fs.readFile(bundlePath), {
          contentType: mime.getType(bundlePath) ?? void 0,
        });

        hooks?.onStorageUploaded?.();
        return {
          fileUrl: hooks?.transformFileUrl?.(response.Key) ?? response.Location,
        };
      },
    };
  };

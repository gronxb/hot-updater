import {
  type BasePluginArgs,
  createStorageKeyBuilder,
  getContentType,
  type StoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import * as admin from "firebase-admin";
import fs from "fs/promises";
import path from "path";

export interface FirebaseStorageConfig extends admin.AppOptions {
  storageBucket: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

export const firebaseStorage =
  (config: FirebaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    let app: admin.app.App;
    try {
      app = admin.app();
    } catch {
      app = admin.initializeApp(config);
    }
    const bucket = app.storage().bucket(config.storageBucket);

    const getStorageKey = createStorageKeyBuilder(config.basePath);
    return {
      name: "firebaseStorage",
      async deleteBundle(bundleId) {
        const key = getStorageKey(bundleId, "bundle.zip");
        try {
          const [files] = await bucket.getFiles({ prefix: key });
          await Promise.all(files.map((file) => file.delete()));
          return {
            storageUri: `gs://${config.storageBucket}/${key}`,
          };
        } catch (e) {
          console.error("Error listing or deleting files:", e);
          throw new Error("Bundle Not Found");
        }
      },

      async uploadBundle(bundleId, bundlePath) {
        try {
          const fileContent = await fs.readFile(bundlePath);
          const contentType = getContentType(bundlePath);
          const filename = path.basename(bundlePath);
          const key = getStorageKey(bundleId, filename);

          const file = bucket.file(key);
          await file.save(fileContent, {
            metadata: {
              contentType: contentType,
            },
          });

          hooks?.onStorageUploaded?.();

          return {
            storageUri: `gs://${config.storageBucket}/${key}`,
          };
        } catch (error) {
          console.error("Error uploading bundle:", error);
          if (error instanceof Error) {
            throw new Error(`Failed to upload bundle: ${error.message}`);
          }
          throw error;
        }
      },
    };
  };

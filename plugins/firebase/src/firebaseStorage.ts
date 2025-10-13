import {
  type BasePluginArgs,
  createStorageKeyBuilder,
  type StoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import * as admin from "firebase-admin";
import fs from "fs/promises";
import mime from "mime";
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
      supportedProtocol: "gs",
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
          const contentType =
            mime.getType(bundlePath) ?? "application/octet-stream";
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
      async getDownloadUrl(storageUri: string) {
        // Simple validation: supported protocol must match
        const u = new URL(storageUri);
        if (u.protocol.replace(":", "") !== "gs") {
          throw new Error("Invalid Firebase storage URI protocol");
        }
        const key = u.pathname.slice(1);
        if (!key) {
          throw new Error("Invalid Firebase storage URI: missing key");
        }
        const file = bucket.file(key);
        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000,
        });
        if (!signedUrl) {
          throw new Error("Failed to generate download URL");
        }
        return { fileUrl: signedUrl };
      },
    };
  };

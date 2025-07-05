import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import * as admin from "firebase-admin";
import fs from "fs/promises";
import mime from "mime";

export interface FirebaseStorageConfig extends admin.AppOptions {
  storageBucket: string;
}

export const firebaseStorage =
  (config: FirebaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    let app: admin.app.App;
    try {
      app = admin.app();
    } catch (e) {
      app = admin.initializeApp(config);
    }
    const bucket = app.storage().bucket(config.storageBucket);

    return {
      name: "firebaseStorage",
      async deleteBundle(bundleId) {
        const Key = `${bundleId}/bundle.zip`;
        try {
          const [files] = await bucket.getFiles({ prefix: Key });
          await Promise.all(files.map((file) => file.delete()));
          return {
            storageUri: `gs://${config.storageBucket}/${Key}`,
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
          const key = `${bundleId}/${filename}`;

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
          if (error instanceof Error) {
            throw new Error(error.message);
          }
          throw error;
        }
      },

      // Native build operations
      async uploadNativeBuild(nativeBuildId, nativeBuildPath) {
        try {
          const fileContent = await fs.readFile(nativeBuildPath);
          const contentType =
            mime.getType(nativeBuildPath) ?? "application/octet-stream";
          const filename = path.basename(nativeBuildPath);
          const key = `native-builds/${nativeBuildId}/${filename}`;

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
          if (error instanceof Error) {
            throw new Error(`Failed to upload native build: ${error.message}`);
          }
          throw error;
        }
      },

      async deleteNativeBuild(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;
        try {
          const [files] = await bucket.getFiles({ prefix });
          if (files.length === 0) {
            throw new Error("Native build not found");
          }
          await Promise.all(files.map((file) => file.delete()));
          return {
            storageUri: `gs://${config.storageBucket}/${prefix}`,
          };
        } catch (e) {
          console.error("Error listing or deleting native build files:", e);
          throw new Error("Native build not found or failed to delete");
        }
      },

      async getNativeBuildDownloadUrl(nativeBuildId) {
        try {
          const prefix = `native-builds/${nativeBuildId}`;
          const [files] = await bucket.getFiles({ prefix });
          
          if (files.length === 0) {
            throw new Error("Native build not found");
          }

          // Get the first file (should be the native build artifact)
          const file = files[0];
          
          // Generate signed URL valid for 1 hour
          const [signedUrl] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
          });

          return {
            fileUrl: signedUrl,
          };
        } catch (error) {
          if (error instanceof Error) {
            throw new Error(`Failed to generate download URL: ${error.message}`);
          }
          throw error;
        }
      },
    };
  };

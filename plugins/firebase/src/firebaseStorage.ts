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

      async upload(key: string, filePath: string) {
        try {
          const fileContent = await fs.readFile(filePath);
          const contentType =
            mime.getType(filePath) ?? "application/octet-stream";
          const filename = path.basename(filePath);
          const fullKey = `${key}/${filename}`;

          const file = bucket.file(fullKey);
          await file.save(fileContent, {
            metadata: {
              contentType: contentType,
            },
          });

          hooks?.onStorageUploaded?.();

          return {
            storageUri: `gs://${config.storageBucket}/${fullKey}`,
          };
        } catch (error) {
          if (error instanceof Error) {
            throw new Error(error.message);
          }
          throw error;
        }
      },

      async delete(storageUri: string) {
        // Parse gs://bucket-name/key from storageUri
        const match = storageUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid Firebase storage URI format");
        }

        const [, bucketName, key] = match;
        if (bucketName !== config.storageBucket) {
          throw new Error("Storage URI bucket does not match configured bucket");
        }

        try {
          const [files] = await bucket.getFiles({ prefix: key });
          if (files.length === 0) {
            throw new Error("File not found in storage");
          }
          await Promise.all(files.map((file) => file.delete()));
        } catch (e) {
          console.error("Error listing or deleting files:", e);
          throw new Error("File not found or failed to delete");
        }
      },

      async getDownloadUrl(storageUri: string) {
        // Parse gs://bucket-name/key from storageUri
        const match = storageUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          throw new Error("Invalid Firebase storage URI format");
        }

        const [, bucketName, key] = match;
        if (bucketName !== config.storageBucket) {
          throw new Error("Storage URI bucket does not match configured bucket");
        }

        try {
          // If key represents a directory prefix, find the actual file
          let actualKey = key;
          if (!key.includes('.')) {
            const [files] = await bucket.getFiles({ prefix: key });
            if (files.length === 0) {
              throw new Error("File not found in storage");
            }
            actualKey = files[0].name;
          }

          const file = bucket.file(actualKey);

          // Generate signed URL valid for 1 hour
          const [signedUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
          });

          return {
            fileUrl: signedUrl,
          };
        } catch (error) {
          if (error instanceof Error) {
            throw new Error(
              `Failed to generate download URL: ${error.message}`,
            );
          }
          throw error;
        }
      },
    };
  };

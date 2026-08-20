import fs from "fs/promises";
import path from "path";

import {
  createStorageKeyBuilder,
  createUniversalStoragePlugin,
  getContentType,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

export interface FirebaseStorageConfig extends AppOptions {
  storageBucket: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

export const firebaseStorage =
  createUniversalStoragePlugin<FirebaseStorageConfig>({
    name: "firebaseStorage",
    supportedProtocol: "gs",
    factory: (config) => {
      const app = getApps().length ? getApp() : initializeApp(config);
      const bucket = getStorage(app).bucket(config.storageBucket);

      const getStorageKey = createStorageKeyBuilder(config.basePath);

      return {
        node: {
          async delete(storageUri) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            try {
              const [files] = await bucket.getFiles({ prefix: key });
              await Promise.all(files.map((file) => file.delete()));
            } catch (e) {
              console.error("Error listing or deleting files:", e);
              throw new Error("Bundle Not Found");
            }
          },

          async upload(key, filePath) {
            try {
              const fileContent = await fs.readFile(filePath);
              const contentType = getContentType(filePath);
              const filename = path.basename(filePath);
              const storageKey = getStorageKey(key, filename);

              const file = bucket.file(storageKey);
              await file.save(fileContent, {
                metadata: {
                  contentType: contentType,
                  cacheControl: "public, max-age=31536000, immutable",
                },
              });

              return {
                storageUri: `gs://${config.storageBucket}/${storageKey}`,
              };
            } catch (error) {
              console.error("Error uploading bundle:", error);
              if (error instanceof Error) {
                throw new Error(`Failed to upload bundle: ${error.message}`);
              }
              throw error;
            }
          },
          async exists(storageUri: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            const [exists] = await bucket.file(key).exists();
            return exists;
          },
          async downloadFile(storageUri: string, filePath: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await bucket.file(key).download({ destination: filePath });
          },
        },
        runtime: {
          async readText(storageUri: string) {
            const { bucket: bucketName, key } = parseStorageUri(
              storageUri,
              "gs",
            );
            if (bucketName !== config.storageBucket) {
              throw new Error(
                `Bucket name mismatch: expected "${config.storageBucket}", but found "${bucketName}".`,
              );
            }

            try {
              const [contents] = await bucket.file(key).download();
              return contents.toString("utf8");
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === 404
              ) {
                return null;
              }

              throw error;
            }
          },
          async getDownloadUrl(storageUri: string) {
            const { key } = parseStorageUri(storageUri, "gs");
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
        },
      };
    },
  });

import {
  createStorageKeyBuilder,
  createStoragePlugin,
  parseStorageUri,
  type StoragePluginWith,
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
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /** Optional CDN base URL. Firebase signed URLs are used when omitted. */
  cdnUrl?: string;
  /** Firebase signed URL lifetime in seconds. @default 3600 */
  signedUrlExpiresIn?: number;
}

export const firebaseStorage = (
  config: FirebaseStorageConfig,
): StoragePluginWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  const app = getApps().length ? getApp() : initializeApp(config);
  const bucket = getStorage(app).bucket(config.storageBucket);
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "gs");
    if (parsed.bucket !== config.storageBucket) {
      throw new Error(
        `Bucket name mismatch: expected "${config.storageBucket}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "firebaseStorage",
    protocol: "gs",
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      await bucket.file(storageKey).save(body, {
        metadata: {
          contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      return { storageUri: `gs://${config.storageBucket}/${storageKey}` };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        const [body] = await bucket.file(key).download();
        return { response: new Response(body) };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 404
        ) {
          return { response: null };
        }
        throw error;
      }
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      if (config.cdnUrl) {
        return {
          url: `${config.cdnUrl.replace(/\/+$/, "")}/${key}`,
        };
      }
      const [url] = await bucket.file(key).getSignedUrl({
        action: "read",
        expires: Date.now() + (config.signedUrlExpiresIn ?? 3600) * 1000,
      });
      if (!url) throw new Error("Failed to generate Firebase download URL");
      return { url };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const [exists] = await bucket.file(key).exists();
      return { exists };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await bucket.file(key).delete({ ignoreNotFound: true });
      return { storageUri };
    },
  });
};

import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
  type StorageObject,
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

/** Signed URLs kept per adapter, enough for a few Bundles' assets. */
const MAX_CACHED_SIGNED_URLS = 10_000;
/** Objects deleted at once: Cloud Storage deletes one object a request. */
const DELETE_CONCURRENCY = 16;

export const firebaseStorage = (
  config: FirebaseStorageConfig,
): StorageAdapterWith<
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects"
> => {
  const app = getApps().length ? getApp() : initializeApp(config);
  const bucket = getStorage(app).bucket(config.storageBucket);
  const getStorageKey = createStorageKeyBuilder(config.basePath);
  const basePrefix = getStorageKey() ? `${getStorageKey()}/` : "";
  /**
   * Signed URLs by object. Without a private key, as in Cloud Functions, each
   * signature is an IAM signBlob request, and an update check returns a URL
   * for every asset of its Bundle: each URL is reused until half its lifetime
   * has passed.
   */
  const signedUrls = new Map<
    string,
    { readonly url: Promise<string>; readonly renewAt: number }
  >();
  const signUrl = async (key: string) => {
    const expiresAt = Date.now() + (config.signedUrlExpiresIn ?? 3600) * 1000;
    const [url] = await bucket.file(key).getSignedUrl({
      action: "read",
      expires: expiresAt,
    });
    if (!url) throw new Error("Failed to generate Firebase download URL");
    return url;
  };
  const getSignedUrl = (key: string) => {
    const cached = signedUrls.get(key);
    if (cached && Date.now() < cached.renewAt) return cached.url;

    const url = signUrl(key);
    const entry = {
      url,
      renewAt: Date.now() + ((config.signedUrlExpiresIn ?? 3600) * 1000) / 2,
    };
    signedUrls.delete(key);
    signedUrls.set(key, entry);
    if (signedUrls.size > MAX_CACHED_SIGNED_URLS) {
      signedUrls.delete(signedUrls.keys().next().value!);
    }
    url.catch(() => {
      if (signedUrls.get(key) === entry) signedUrls.delete(key);
    });
    return url;
  };

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "gs");
    if (parsed.bucket !== config.storageBucket) {
      throw new Error(
        `Bucket name mismatch: expected "${config.storageBucket}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStorageAdapter({
    name: "firebaseStorage",
    protocol: "gs",
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      await bucket.file(storageKey).save(bytes, {
        metadata: {
          contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      return {
        storageUri: createStorageUri({
          bucket: config.storageBucket,
          key: storageKey,
          protocol: "gs",
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        const file = bucket.file(key);
        const [[body], [metadata]] = await Promise.all([
          file.download(),
          file.getMetadata(),
        ]);
        const headers = new Headers();
        if (metadata.contentType) {
          headers.set("content-type", metadata.contentType);
        }
        headers.set("content-length", String(metadata.size ?? body.byteLength));
        return { response: new Response(body, { headers }) };
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
        const storageUrl = new URL(storageUri);
        const downloadUrl = new URL(config.cdnUrl);
        downloadUrl.pathname = `${downloadUrl.pathname.replace(/\/+$/, "")}${storageUrl.pathname}`;
        downloadUrl.search = "";
        downloadUrl.hash = "";
        return {
          url: downloadUrl.toString(),
        };
      }
      return { url: await getSignedUrl(key) };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const [exists] = await bucket.file(key).exists();
      return { exists };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await bucket.file(key).delete({ ignoreNotFound: true });
      return { deleted: true };
    },
    async listObjects(prefix) {
      const folder = getStorageKey(prefix ?? "");
      const [files] = await bucket.getFiles({
        autoPaginate: true,
        prefix: folder ? `${folder}/` : "",
      });
      const objects: StorageObject[] = [];
      for (const file of files) {
        if (!file.name.startsWith(basePrefix)) continue;
        let storageUri: string;
        // A key no `put` writes, such as a folder marker, has no URI.
        try {
          storageUri = createStorageUri({
            bucket: config.storageBucket,
            key: file.name,
            protocol: "gs",
          });
        } catch {
          continue;
        }
        const { size, updated } = file.metadata;
        objects.push({
          key: file.name.slice(basePrefix.length),
          ...(updated ? { lastModifiedAt: new Date(updated) } : {}),
          size: Number(size ?? 0),
          storageUri,
        });
      }
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));
      for (let offset = 0; offset < keys.length; offset += DELETE_CONCURRENCY) {
        await Promise.all(
          keys
            .slice(offset, offset + DELETE_CONCURRENCY)
            .map((key) => bucket.file(key).delete({ ignoreNotFound: true })),
        );
      }
    },
  });
};

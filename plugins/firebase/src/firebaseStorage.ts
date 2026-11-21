import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/**
 * Attempts at an upload a transient failure ends, as the AWS SDK's standard
 * retry mode makes for `s3Storage`.
 */
const UPLOAD_ATTEMPTS = 3;
/** The upper bound of the first retry's delay, doubled for each retry. */
const UPLOAD_RETRY_DELAY_MS = 500;
/**
 * The largest body `put` holds in memory to send it again. A larger one,
 * such as a native build, is streamed once.
 */
const REPLAYABLE_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * `body` read into memory when it has at most REPLAYABLE_UPLOAD_BYTES, so a
 * failed upload can send it again, or else a stream of the same bytes.
 */
const readReplayableBody = async (
  body: ReadableStream<Uint8Array>,
  contentLength: number | undefined,
): Promise<Uint8Array | ReadableStream<Uint8Array>> => {
  if (contentLength !== undefined && contentLength > REPLAYABLE_UPLOAD_BYTES) {
    return body;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (byteLength <= REPLAYABLE_UPLOAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
    chunks.push(value);
    byteLength += value.byteLength;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks.splice(0)) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

/** The HTTP status Cloud Storage failed a request with. */
const failedStatusOf = (error: unknown) => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "number" ? code : undefined;
};

/** One line that says how an upload of `key` failed. */
const uploadError = (key: string, error: unknown, transient: boolean) => {
  const status = failedStatusOf(error);
  if (status === undefined) {
    return transient
      ? new Error(
          `Firebase Storage did not answer while uploading ${key}: ${(error as Error).message}`,
          { cause: error },
        )
      : error;
  }
  // A gateway answers some failures, such as a 502, with an HTML page.
  const detail =
    transient || status >= 500 ? "" : `: ${(error as Error).message}`;
  return new Error(
    `Firebase Storage answered HTTP ${status} while uploading ${key}${detail}`,
    { cause: error },
  );
};

const waitBeforeRetry = (retry: number) =>
  new Promise((resolve) =>
    setTimeout(
      resolve,
      UPLOAD_RETRY_DELAY_MS * 2 ** (retry - 1) * (0.5 + Math.random() / 2),
    ),
  );

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
  // The app is bound now, as the first adapter binds the default one; the
  // bucket opens on first use, so a config loads without its settings.
  const app = getApps().length ? getApp() : initializeApp(config);
  let opened: ReturnType<ReturnType<typeof getStorage>["bucket"]> | undefined;
  const bucket = () =>
    (opened ??= getStorage(app).bucket(config.storageBucket));
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
    const [url] = await bucket().file(key).getSignedUrl({
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
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const file = bucket().file(storageKey);
      const payload = await readReplayableBody(body, contentLength);
      const replayable = payload instanceof Uint8Array;
      // One request, which the SDK sends once: it retries an upload only
      // under a generation precondition, which would fail concurrent puts of
      // one key. An attempt that fails after Storage kept the object is
      // overwritten with the same bytes, so `put` sends it again itself.
      const upload = () => {
        const destination = file.createWriteStream({
          resumable: false,
          metadata: {
            contentType,
            cacheControl: "public, max-age=31536000, immutable",
          },
        });
        return replayable
          ? new Promise<void>((resolve, reject) => {
              destination.once("error", reject).once("finish", resolve);
              destination.end(payload);
            })
          : pipeline(
              Readable.fromWeb(
                payload as import("node:stream/web").ReadableStream<Uint8Array>,
              ),
              destination,
            );
      };
      for (let attempt = 1; ; attempt++) {
        try {
          await upload();
          break;
        } catch (error) {
          const transient =
            file.storage.retryOptions.retryableErrorFn?.(error as never) ===
            true;
          if (!transient || !replayable || attempt === UPLOAD_ATTEMPTS) {
            throw uploadError(storageKey, error, transient);
          }
          await waitBeforeRetry(attempt);
        }
      }
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
        const file = bucket().file(key);
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
      const [exists] = await bucket().file(key).exists();
      return { exists };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await bucket().file(key).delete({ ignoreNotFound: true });
      return { deleted: true };
    },
    async listObjects(prefix) {
      const folder = getStorageKey(prefix ?? "");
      const [files] = await bucket().getFiles({
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
            .map((key) => bucket().file(key).delete({ ignoreNotFound: true })),
        );
      }
    },
  });
};

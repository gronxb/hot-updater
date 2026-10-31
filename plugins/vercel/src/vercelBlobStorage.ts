import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  type Lazy,
  parseStorageUri,
  type StorageAdapterWith,
  type StorageObject,
} from "@hot-updater/plugin-core";
import {
  BlobNotFoundError,
  del,
  get,
  head,
  issueSignedToken,
  type IssuedSignedToken,
  list,
  presignUrl,
  put,
} from "@vercel/blob";

export interface VercelBlobStorageConfig {
  /**
   * The Blob store's read-write token, `vercel_blob_rw_<storeId>_<secret>`:
   * the `BLOB_READ_WRITE_TOKEN` Vercel adds to a project the store connects
   * to. Or a function that returns it, such as `secret("<name>")` in
   * `hot-updater.config.ts`: called on first use, so a config loads without
   * the token.
   */
  token: Lazy<string>;
  /** Base path where bundles will be stored in the store. */
  basePath?: string;
  /**
   * Lifetime of the download URLs in seconds, at most seven days, Vercel's
   * limit. @default 3600
   */
  signedUrlExpiresIn?: number;
}

type VercelBlobStorageOperations =
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

const PROTOCOL = "vercel-blob";
const ONE_YEAR_IN_SECONDS = 31_536_000;
/** Above this, `put` uploads in parts. */
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
/** One delegation presigns every private download URL for a day. */
const DELEGATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Vercel's limit on a delegation, and so on a presigned URL. */
const MAX_SIGNED_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const DELETE_BATCH_SIZE = 100;

/**
 * A character @vercel/blob drops from a pathname's URL, such as `#`, or
 * reads as an escape, such as `%`, so `get` and presigned URLs miss the
 * object; control characters; and the escape character `!`.
 */
const ESCAPED_CHARACTER = /[#?%\\!\p{Cc}]/gu;
const ESCAPE_SEQUENCE = /!([0-9A-F]{2})/gu;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The pathname Blob keeps a key under: each escaped character as `!` and
 * the two hex digits of each of its UTF-8 bytes, such as `#` as `!23`.
 * Distinct keys keep distinct pathnames, and deploy's keys, such as
 * `<bundleId>/manifest.json`, are stored as they are.
 */
const toPathname = (key: string) =>
  key.replace(ESCAPED_CHARACTER, (character) =>
    Array.from(
      utf8.encode(character),
      (byte) => `!${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join(""),
  );

/** The key `toPathname` stored under `pathname`, or null for a pathname it never makes. */
const fromPathname = (pathname: string): string | null => {
  const bytes: number[] = [];
  const flush = (parts: string[]) => {
    if (bytes.length === 0) return true;
    try {
      parts.push(utf8Decoder.decode(new Uint8Array(bytes)));
    } catch {
      return false;
    }
    bytes.length = 0;
    return true;
  };
  const parts: string[] = [];
  let index = 0;
  for (const match of pathname.matchAll(ESCAPE_SEQUENCE)) {
    if (match.index !== index) {
      if (!flush(parts)) return null;
      parts.push(pathname.slice(index, match.index));
    }
    bytes.push(Number.parseInt(match[1] as string, 16));
    index = match.index + match[0].length;
  }
  if (!flush(parts)) return null;
  parts.push(pathname.slice(index));
  const key = parts.join("");
  return toPathname(key) === pathname ? key : null;
};

/** The store ID a read-write token belongs to, as Vercel's CLI reads it. */
const storeIdOf = (token: string) => {
  const [prefix, kind, rw, id] = token.split("_");
  if (prefix !== "vercel" || kind !== "blob" || rw !== "rw" || !id) {
    throw new Error(
      "vercelBlobStorage needs the store's read-write token (vercel_blob_rw_...).",
    );
  }
  return `store_${id}`;
};

/** A private store's objects: only an API key holder's signed URL reaches them. */
const access = "private";

/**
 * Bundles in a private Vercel Blob store. Devices download from presigned URLs
 * that expire, so the store's objects never sit at a public address.
 */
export const vercelBlobStorage = (
  config: VercelBlobStorageConfig,
): StorageAdapterWith<VercelBlobStorageOperations> => {
  // Read on first use, so a config loads without the token.
  let resolved:
    | Promise<{ readonly token: string; readonly storeId: string }>
    | undefined;
  const store = () =>
    (resolved ??= (async () => {
      const token =
        typeof config.token === "function"
          ? await config.token()
          : config.token;
      return { token, storeId: storeIdOf(token) };
    })().catch((error: unknown) => {
      resolved = undefined;
      throw error;
    }));
  const normalizedBasePath = config.basePath?.replace(/^\/+|\/+$/g, "") ?? "";
  const getStorageKey = createStorageKeyBuilder(normalizedBasePath);
  const expiresIn = config.signedUrlExpiresIn ?? 3600;
  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_SIGNED_LIFETIME_SECONDS
  ) {
    throw new Error(
      `vercelBlobStorage signedUrlExpiresIn must be between 1 and ${MAX_SIGNED_LIFETIME_SECONDS} seconds (seven days).`,
    );
  }
  const expiresInMs = expiresIn * 1000;

  let delegation: Promise<IssuedSignedToken> | undefined;
  /** A read delegation that outlives `validUntil`, shared by every URL it presigns. */
  const delegationUntil = async (validUntil: number) => {
    const current = await delegation?.catch(() => undefined);
    if (current !== undefined && current.validUntil >= validUntil) {
      return current;
    }
    const { token } = await store();
    const issued = issueSignedToken({
      token,
      operations: ["get"],
      validUntil:
        Date.now() +
        Math.min(
          MAX_SIGNED_LIFETIME_SECONDS * 1000,
          Math.max(DELEGATION_LIFETIME_MS, expiresInMs * 2),
        ),
    });
    delegation = issued;
    return issued;
  };

  const parseAndValidate = async (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, PROTOCOL);
    const { token, storeId } = await store();
    if (parsed.bucket !== storeId) {
      throw new Error(
        `Blob store mismatch: expected "${storeId}", but found "${parsed.bucket}".`,
      );
    }
    return { ...parsed, token };
  };

  const getListPrefix = (prefix = "") => {
    const value = [normalizedBasePath, prefix.replace(/^\/+|\/+$/g, "")]
      .filter(Boolean)
      .join("/");
    return value ? `${toPathname(value)}/` : "";
  };

  const getRelativeKey = (key: string) => {
    if (!normalizedBasePath) return key;
    const basePrefix = `${normalizedBasePath}/`;
    return key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
  };

  return createStorageAdapter({
    name: "vercelBlobStorage",
    protocol: PROTOCOL,
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const { token, storeId } = await store();
      const storageUri = createStorageUri({
        protocol: PROTOCOL,
        bucket: storeId,
        key: storageKey,
      });
      await put(toPathname(storageKey), body, {
        access,
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: ONE_YEAR_IN_SECONDS,
        contentType,
        multipart:
          contentLength === undefined ||
          contentLength > MULTIPART_THRESHOLD_BYTES,
      });
      return { storageUri };
    },
    async get({ storageUri }) {
      const { key, token } = await parseAndValidate(storageUri);
      const result = await get(toPathname(key), {
        access,
        token,
        useCache: false,
      });
      if (result?.statusCode !== 200) return { response: null };
      // Blob compresses some transfers; the stream is the decoded bytes, so
      // only an unencoded response's length is the object's size.
      const contentLength = result.headers.get("content-length");
      return {
        response: new Response(result.stream, {
          headers: {
            "content-type": result.blob.contentType,
            ...(contentLength && !result.headers.has("content-encoding")
              ? { "content-length": contentLength }
              : {}),
          },
        }),
      };
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = await parseAndValidate(storageUri);
      const pathname = toPathname(key);
      const validUntil = Date.now() + expiresInMs;
      const { presignedUrl } = await presignUrl(
        await delegationUntil(validUntil),
        { access, operation: "get", pathname, validUntil },
      );
      return { url: presignedUrl };
    },
    async exists({ storageUri }) {
      const { key, token } = await parseAndValidate(storageUri);
      try {
        await head(toPathname(key), { token });
        return { exists: true };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return { exists: false };
        throw error;
      }
    },
    async delete({ storageUri }) {
      const { key, token } = await parseAndValidate(storageUri);
      await del(toPathname(key), { token });
      return { deleted: true };
    },
    async listObjects(prefix) {
      const { token, storeId } = await store();
      const objects: StorageObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({
          token,
          prefix: getListPrefix(prefix),
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const blob of page.blobs) {
          const key = fromPathname(blob.pathname);
          if (key === null) continue;
          let storageUri: string;
          try {
            storageUri = createStorageUri({
              protocol: PROTOCOL,
              bucket: storeId,
              key,
            });
          } catch {
            continue;
          }
          objects.push({
            key: getRelativeKey(key),
            lastModifiedAt: blob.uploadedAt,
            size: blob.size,
            storageUri,
          });
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const { token } = await store();
      const pathnames = relativeKeys.map((key) =>
        toPathname(getStorageKey(key)),
      );
      for (
        let offset = 0;
        offset < pathnames.length;
        offset += DELETE_BATCH_SIZE
      ) {
        await del(pathnames.slice(offset, offset + DELETE_BATCH_SIZE), {
          token,
        });
      }
    },
  });
};

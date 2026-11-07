import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapter,
  type StorageAdapterWith,
  type StorageObject,
} from "@hot-updater/plugin-core";

import { type S3CredentialsOption, toSdkCredentials } from "./lazyCredentials";

export type { S3ClientConfig };
export type { LazyS3Credentials, S3CredentialsOption } from "./lazyCredentials";

/** Who the adapter is: its name and the scheme of the URIs it writes. */
export interface S3StorageIdentity {
  /** The adapter's name, such as `s3Storage`. */
  name: string;
  /** The scheme of the storage URIs it writes, such as `s3`. */
  protocol: string;
}

export interface S3StorageConfig extends Omit<S3ClientConfig, "credentials"> {
  /**
   * The SDK's credentials, or access keys whose fields are lazy, such as
   * `secret("<name>")`, read once, on the first request.
   */
  credentials?: S3CredentialsOption;
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /**
   * The URL devices download an object from, such as a CDN's. Without it, a
   * presigned URL that expires after `signedUrlExpiresIn`.
   */
  getDownloadUrl?: StorageAdapter["getDownloadUrl"];
  /**
   * Lifetime of the presigned download URLs in seconds, at most seven days,
   * the SigV4 limit. @default 3600
   */
  signedUrlExpiresIn?: number;
}

export type S3StorageOperations =
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

/** Devices download right after the update check that returns the URL. */
const DEFAULT_SIGNED_LIFETIME_SECONDS = 3600;
/** SigV4's limit on a presigned URL. */
const MAX_SIGNED_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
/** DeleteObjects takes at most 1000 keys a request. */
const DELETE_BATCH_SIZE = 1000;

const isObjectNotFoundError = (error: unknown) => {
  if (
    error instanceof Error &&
    (error.name === "NotFound" || error.name === "NoSuchKey")
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404
  );
};

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

/**
 * A storage adapter over a bucket's S3 API, which AWS S3, Cloudflare R2, and
 * Neon Object Storage all serve. Each provider package passes its own name,
 * URI protocol, and client defaults.
 */
export const createS3Storage = (
  { name, protocol }: S3StorageIdentity,
  config: S3StorageConfig,
): StorageAdapterWith<S3StorageOperations> => {
  const {
    bucketName,
    basePath,
    getDownloadUrl,
    signedUrlExpiresIn = DEFAULT_SIGNED_LIFETIME_SECONDS,
    credentials,
    ...clientConfig
  } = config;
  if (
    !Number.isFinite(signedUrlExpiresIn) ||
    signedUrlExpiresIn <= 0 ||
    signedUrlExpiresIn > MAX_SIGNED_LIFETIME_SECONDS
  ) {
    throw new Error(
      `${name} signedUrlExpiresIn must be between 1 and ${MAX_SIGNED_LIFETIME_SECONDS} seconds (seven days).`,
    );
  }
  const client = new S3Client({
    ...clientConfig,
    credentials: toSdkCredentials(credentials),
  });
  const normalizedBasePath = trimSlashes(basePath ?? "");
  const getStorageKey = createStorageKeyBuilder(normalizedBasePath);

  const getListPrefix = (prefix = "") => {
    const value = [normalizedBasePath, trimSlashes(prefix)]
      .filter(Boolean)
      .join("/");
    return value ? `${value}/` : "";
  };

  /**
   * The URI `put` returns for the key, or null for a key no `put` writes,
   * such as a folder marker that ends in "/".
   */
  const getListedStorageUri = (key: string) => {
    try {
      return createStorageUri({ bucket: bucketName, key, protocol });
    } catch {
      return null;
    }
  };

  const getRelativeKey = (key: string) => {
    if (!normalizedBasePath) return key;
    const basePrefix = `${normalizedBasePath}/`;
    return key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
  };

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, protocol);
    if (parsed.bucket !== bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStorageAdapter({
    name,
    protocol,
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      await new Upload({
        client,
        params: {
          Body: body,
          Bucket: bucketName,
          CacheControl: "max-age=31536000",
          ...(contentLength === undefined
            ? {}
            : { ContentLength: contentLength }),
          ContentType: contentType,
          Key: storageKey,
        },
      }).done();
      return {
        storageUri: createStorageUri({
          bucket: bucketName,
          key: storageKey,
          protocol,
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
        );
        if (!response.Body) return { response: null };
        const headers = new Headers();
        if (response.ContentType) {
          headers.set("content-type", response.ContentType);
        }
        if (response.ContentLength !== undefined) {
          headers.set("content-length", String(response.ContentLength));
        }
        return {
          response: new Response(response.Body.transformToWebStream(), {
            headers,
          }),
        };
      } catch (error) {
        if (isObjectNotFoundError(error)) return { response: null };
        throw error;
      }
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      if (getDownloadUrl) return getDownloadUrl({ storageUri });
      return {
        url: await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
          { expiresIn: signedUrlExpiresIn },
        ),
      };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucketName, Key: key }),
        );
        return { exists: true };
      } catch (error) {
        if (isObjectNotFoundError(error)) return { exists: false };
        throw error;
      }
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await client.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
      );
      return { deleted: true };
    },
    async listObjects(prefix) {
      const objects: StorageObject[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
            Prefix: getListPrefix(prefix),
          }),
        );
        for (const object of response.Contents ?? []) {
          if (!object.Key) continue;
          const storageUri = getListedStorageUri(object.Key);
          if (storageUri === null) continue;
          objects.push({
            key: getRelativeKey(object.Key),
            lastModifiedAt: object.LastModified,
            size: object.Size ?? 0,
            storageUri,
          });
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));
      for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
        const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (response.Errors && response.Errors.length > 0) {
          throw new Error(
            `Failed to delete ${response.Errors.length} S3 object(s) from bucket "${bucketName}".`,
          );
        }
      }
    },
  });
};

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  createStorageKeyBuilder,
  createStorageDownloadUrl,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

export interface R2S3StorageConfig extends S3ClientConfig {
  accountId: string;
  bucketName: string;
  credentials: NonNullable<S3ClientConfig["credentials"]>;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /** Required when this storage serves downloads through createHotUpdater. */
  downloadUrlSigningKey?: string;
}

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

export const createR2S3Storage = (
  config: R2S3StorageConfig,
): StoragePluginWith<"put" | "get" | "exists" | "delete"> => {
  const {
    accountId,
    basePath,
    bucketName,
    downloadUrlSigningKey,
    endpoint,
    forcePathStyle,
    region,
    ...s3Config
  } = config;
  const client = new S3Client({
    ...s3Config,
    endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: forcePathStyle ?? true,
    region: region ?? "auto",
  });
  const getStorageKey = createStorageKeyBuilder(basePath);
  const getDownloadUrl = downloadUrlSigningKey
    ? createStorageDownloadUrl(downloadUrlSigningKey)
    : undefined;

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "r2");
    if (parsed.bucket !== bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "r2Storage",
    protocol: "r2",
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      await new Upload({
        client,
        params: {
          Body: body,
          Bucket: bucketName,
          CacheControl: "max-age=31536000",
          ContentLength: contentLength,
          ContentType: contentType,
          Key: storageKey,
        },
      }).done();
      return {
        storageUri: createStorageUri({
          protocol: "r2",
          bucket: bucketName,
          key: storageKey,
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
        if (response.ContentType)
          headers.set("content-type", response.ContentType);
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
    ...(getDownloadUrl
      ? {
          async getDownloadUrl({ storageUri }: { storageUri: string }) {
            parseAndValidate(storageUri);
            return getDownloadUrl({ storageUri });
          },
        }
      : {}),
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
  });
};

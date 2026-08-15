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
import {
  createStorageDownloadUrl,
  createStorageKeyBuilder,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
  type StorageObject,
  type StoragePlugin,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";

export interface S3StorageConfig extends S3ClientConfig {
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  downloadUrlSigningKey?: string;
  getDownloadUrl?: StoragePlugin["getDownloadUrl"];
}

export type S3StorageConfigWithDownloadUrl = S3StorageConfig &
  (
    | { downloadUrlSigningKey: string }
    | { getDownloadUrl: NonNullable<StoragePlugin["getDownloadUrl"]> }
  );

type S3StorageOperations =
  | "put"
  | "get"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

const isObjectNotFoundError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "NotFound" || error.name === "NoSuchKey");

export function s3Storage(
  config: S3StorageConfigWithDownloadUrl,
): StoragePluginWith<S3StorageOperations | "getDownloadUrl">;
export function s3Storage(
  config: S3StorageConfig,
): StoragePluginWith<S3StorageOperations>;
export function s3Storage(
  config: S3StorageConfig,
): StoragePluginWith<S3StorageOperations> {
  const {
    bucketName,
    basePath,
    downloadUrlSigningKey,
    getDownloadUrl: configuredGetDownloadUrl,
    ...s3Config
  } = config;
  const getDownloadUrl =
    configuredGetDownloadUrl ??
    (downloadUrlSigningKey
      ? createStorageDownloadUrl(downloadUrlSigningKey)
      : undefined);
  const client = new S3Client(applyS3RuntimeAwsConfig(s3Config));
  const normalizedBasePath = basePath?.replace(/^\/+|\/+$/g, "") ?? "";
  const getStorageKey = createStorageKeyBuilder(normalizedBasePath);

  const getListPrefix = (prefix = "") => {
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    const value = [normalizedBasePath, normalizedPrefix]
      .filter(Boolean)
      .join("/");
    return value ? `${value}/` : "";
  };

  const getRelativeKey = (key: string) => {
    if (!normalizedBasePath) {
      return key;
    }

    const basePrefix = `${normalizedBasePath}/`;
    return key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
  };

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "s3");
    if (parsed.bucket !== bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "s3Storage",
    protocol: "s3",
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
          if (!object.Key) {
            continue;
          }

          objects.push({
            key: getRelativeKey(object.Key),
            lastModifiedAt: object.LastModified,
            size: object.Size ?? 0,
            storageUri: `s3://${bucketName}/${object.Key}`,
          });
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));

      for (let offset = 0; offset < keys.length; offset += 1000) {
        const batch = keys.slice(offset, offset + 1000);
        if (batch.length === 0) {
          continue;
        }

        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        if (response.Errors && response.Errors.length > 0) {
          throw new Error(
            `Failed to delete ${response.Errors.length} S3 object(s).`,
          );
        }
      }
    },
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const upload = new Upload({
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
      });
      const response = await upload.done();
      if (!response.Bucket || !response.Key) {
        throw new Error("Upload failed");
      }
      return {
        storageUri: createStorageUri({
          bucket: bucketName,
          key: storageKey,
          protocol: "s3",
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
          async getDownloadUrl(input: { storageUri: string }) {
            parseAndValidate(input.storageUri);
            return getDownloadUrl(input);
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
}

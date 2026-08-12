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
  parseStorageUri,
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

const isObjectNotFoundError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "NotFound" || error.name === "NoSuchKey");

export const s3Storage = (
  config: S3StorageConfig,
): StoragePluginWith<"put" | "get" | "exists" | "delete"> => {
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
  const getStorageKey = createStorageKeyBuilder(basePath);

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
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      const upload = new Upload({
        client,
        params: {
          Body: body,
          Bucket: bucketName,
          CacheControl: "max-age=31536000",
          ContentType: contentType,
          Key: storageKey,
        },
      });
      const response = await upload.done();
      if (!response.Bucket || !response.Key) {
        throw new Error("Upload failed");
      }
      return { storageUri: `s3://${bucketName}/${storageKey}` };
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
      return { storageUri };
    },
  });
};

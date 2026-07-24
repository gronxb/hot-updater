import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import mime from "mime";

import { streamToString } from "./utils/streamToString";

const errorProperty = (error: unknown, key: string): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, key)
    : undefined;

export class ArchivedS3DatabaseObjectError extends Error {
  readonly name = "ArchivedS3DatabaseObjectError";

  constructor(
    readonly bucket: string,
    readonly key: string,
    readonly storageClass: string,
    options: ErrorOptions,
  ) {
    super(
      `S3 database object "${key}" in bucket "${bucket}" is archived (${storageClass}). Restore it before using Hot Updater.`,
      options,
    );
  }
}

type VersionedS3Json = {
  readonly data: unknown;
  readonly etag: string;
};

const loadVersionedJsonFromS3 = async (
  client: S3Client,
  bucket: string,
  key: string,
): Promise<VersionedS3Json | null> => {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) return null;
    const text = await streamToString(response.Body);
    if (text.length === 0) {
      throw new Error(`S3 database object "${key}" is empty.`);
    }
    if (!response.ETag) {
      throw new Error(`S3 object "${key}" did not include an ETag.`);
    }
    const parsed: unknown = JSON.parse(text);
    return { data: parsed, etag: response.ETag };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")
    ) {
      return null;
    }
    if (
      error instanceof Error &&
      (error.name === "InvalidObjectState" ||
        errorProperty(error, "Code") === "InvalidObjectState")
    ) {
      const storageClass = errorProperty(error, "StorageClass");
      throw new ArchivedS3DatabaseObjectError(
        bucket,
        key,
        typeof storageClass === "string" ? storageClass : "archived storage",
        { cause: error },
      );
    }
    throw error;
  }
};

export const loadJsonFromS3 = async (
  client: S3Client,
  bucket: string,
  key: string,
): Promise<unknown | null> =>
  (await loadVersionedJsonFromS3(client, bucket, key))?.data ?? null;

const isConditionalWriteConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const metadata = errorProperty(error, "$metadata");
  const status = errorProperty(metadata, "httpStatusCode");
  return (
    error.name === "ConditionalRequestConflict" ||
    error.name === "PreconditionFailed" ||
    status === 409 ||
    status === 412
  );
};

export const compareAndSwapJsonInS3 = async (
  client: S3Client,
  bucket: string,
  key: string,
  expected: unknown | null,
  data: unknown,
): Promise<boolean> => {
  const cacheControl = key.endsWith("_hot-updater/database/v2.json")
    ? "no-cache"
    : "max-age=31536000";
  if (expected === null) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(data),
          ContentType: mime.getType(key) ?? "application/json",
          CacheControl: cacheControl,
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalWriteConflict(error)) return false;
      throw error;
    }
  }
  const current = await loadVersionedJsonFromS3(client, bucket, key);
  if (JSON.stringify(current?.data ?? null) !== JSON.stringify(expected)) {
    return false;
  }
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: mime.getType(key) ?? "application/json",
        CacheControl: cacheControl,
        IfMatch: current?.etag,
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalWriteConflict(error)) return false;
    throw error;
  }
};

export const uploadJsonToS3 = async (
  client: S3Client,
  bucket: string,
  key: string,
  data: unknown,
): Promise<void> => {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: mime.getType(key) ?? "application/json",
      CacheControl: "max-age=31536000",
    }),
  );
};

export const listS3DatabaseObjects = async (
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<readonly string[]> => {
  let continuationToken: string | undefined;
  const keys: string[] = [];
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
};

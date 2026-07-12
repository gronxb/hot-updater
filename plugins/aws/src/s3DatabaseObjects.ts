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

export const loadJsonFromS3 = async (
  client: S3Client,
  bucket: string,
  key: string,
): Promise<unknown | null> => {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) return null;
    const text = await streamToString(response.Body);
    if (text.length === 0) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed;
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

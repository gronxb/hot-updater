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

const S3_DIRECTORY_DELIMITER = "/";
const S3_LIST_OBJECTS_CONCURRENCY = 4;

const normalizeDirectoryPrefix = (prefix: string): string =>
  !prefix || prefix.endsWith(S3_DIRECTORY_DELIMITER)
    ? prefix
    : `${prefix}${S3_DIRECTORY_DELIMITER}`;

const getRelativeDirectoryPrefix = (
  prefix: string,
  rootPrefix: string,
): string =>
  rootPrefix && prefix.startsWith(rootPrefix)
    ? prefix.slice(rootPrefix.length)
    : prefix;

const getDirectoryDepth = (prefix: string, rootPrefix: string): number =>
  getRelativeDirectoryPrefix(prefix, rootPrefix)
    .split(S3_DIRECTORY_DELIMITER)
    .filter(Boolean).length;

const getLastDirectorySegment = (prefix: string): string | undefined =>
  prefix.split(S3_DIRECTORY_DELIMITER).filter(Boolean).at(-1);

const isPlatformDirectoryPrefix = (prefix: string): boolean => {
  const segment = getLastDirectorySegment(prefix);
  return segment === "ios" || segment === "android";
};

const isLegacyBundleStorageDirectoryPrefix = (prefix: string): boolean => {
  const segment = getLastDirectorySegment(prefix);
  return (
    segment !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segment,
    )
  );
};

const isUuidChannelUpdateJsonKey = (
  key: string,
  rootPrefix: string,
  uuidChannels: ReadonlySet<string>,
): boolean => {
  const [channel, platform, target, fileName, ...rest] =
    getRelativeDirectoryPrefix(key, rootPrefix).split(S3_DIRECTORY_DELIMITER);
  return (
    channel !== undefined &&
    uuidChannels.has(channel) &&
    (platform === "ios" || platform === "android") &&
    target !== undefined &&
    target.length > 0 &&
    fileName === "update.json" &&
    rest.length === 0
  );
};

const mapWithConcurrency = async <T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<TResult[]> => {
  const results: Array<TResult | undefined> = [];
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await mapper(item);
      }
    }),
  );
  return results.filter((result): result is TResult => result !== undefined);
};

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
): Promise<unknown> =>
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
  expected: unknown,
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

export const listS3LegacyUpdateManifests = async (
  client: S3Client,
  bucket: string,
  rootPrefix: string,
): Promise<readonly string[]> => {
  const normalizedRootPrefix = normalizeDirectoryPrefix(rootPrefix);
  const listPrefix = async (
    prefix: string,
    delimiter: string | null = S3_DIRECTORY_DELIMITER,
  ) => {
    let continuationToken: string | undefined;
    const keys: string[] = [];
    const commonPrefixes = new Set<string>();
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: delimiter ?? undefined,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      for (const item of response.CommonPrefixes ?? []) {
        if (item.Prefix) commonPrefixes.add(item.Prefix);
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return { commonPrefixes: [...commonPrefixes], keys };
  };

  const collectUpdateJsonKeys = async (prefix: string): Promise<string[]> => {
    const { commonPrefixes, keys } = await listPrefix(prefix);
    const depth = getDirectoryDepth(prefix, normalizedRootPrefix);
    if (depth >= 2) {
      return [
        ...keys.filter((key) => key.endsWith("/update.json")),
        ...commonPrefixes.map((item) => `${item}update.json`),
      ];
    }

    const uuidPrefixes =
      depth === 0
        ? commonPrefixes.filter(isLegacyBundleStorageDirectoryPrefix)
        : [];
    const uuidPrefixSet = new Set(uuidPrefixes);
    const nextPrefixes =
      depth === 0
        ? commonPrefixes.filter((item) => !uuidPrefixSet.has(item))
        : commonPrefixes.filter(isPlatformDirectoryPrefix);
    const nestedKeys = await mapWithConcurrency(
      nextPrefixes,
      S3_LIST_OBJECTS_CONCURRENCY,
      collectUpdateJsonKeys,
    );
    const uuidChannels = new Set(
      uuidPrefixes
        .map(getLastDirectorySegment)
        .filter((item): item is string => item !== undefined),
    );
    const uuidScanPrefixes = [
      ...new Set(
        [...uuidChannels].map(
          (channel) => `${normalizedRootPrefix}${channel[0]}`,
        ),
      ),
    ];
    const uuidChannelKeys = (
      await mapWithConcurrency(
        uuidScanPrefixes,
        S3_LIST_OBJECTS_CONCURRENCY,
        async (scanPrefix) => (await listPrefix(scanPrefix, null)).keys,
      )
    )
      .flat()
      .filter((key) =>
        isUuidChannelUpdateJsonKey(key, normalizedRootPrefix, uuidChannels),
      );
    return [...nestedKeys.flat(), ...uuidChannelKeys];
  };

  return [...new Set(await collectUpdateJsonKeys(normalizedRootPrefix))];
};

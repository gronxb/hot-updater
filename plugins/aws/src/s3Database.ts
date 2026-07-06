import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createBlobDatabasePlugin } from "@hot-updater/plugin-core";
import mime from "mime";

import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";
import { streamToString } from "./utils/streamToString";

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
  /**
   * Base path where database objects will be stored in the bucket.
   */
  basePath?: string;
  /**
   * CloudFront distribution ID used for cache invalidation.
   *
   * If omitted or an empty string, CloudFront invalidation is skipped.
   * This is useful for local development environments (e.g. Localstack)
   * where CloudFront is not available.
   */
  cloudfrontDistributionId?: string;
  /**
   * Wait for CloudFront invalidations to reach `Completed` before finishing.
   *
   * When enabled, invalidation failures and timeouts are surfaced to callers
   * instead of being logged and ignored.
   */
  shouldWaitForInvalidation?: boolean;
  apiBasePath?: string;
}

const DEFAULT_INVALIDATION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_INVALIDATION_TIMEOUT_MS = 5 * 60 * 1_000;
const S3_LIST_OBJECTS_CONCURRENCY = 4;
const S3_DIRECTORY_DELIMITER = "/";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getS3ErrorProperty = (error: unknown, key: string) => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const isArchivedS3ObjectError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "InvalidObjectState" ||
    getS3ErrorProperty(error, "Code") === "InvalidObjectState"
  );
};

const createArchivedS3ObjectError = ({
  bucket,
  key,
  error,
}: {
  bucket: string;
  key: string;
  error: unknown;
}) => {
  const storageClass =
    getS3ErrorProperty(error, "StorageClass") ?? "archived storage";
  const nextError = new Error(
    `S3 object "${key}" in bucket "${bucket}" is archived (${storageClass}) and cannot be read. Restore the object in S3 or exclude Hot Updater metadata from lifecycle archival: "**/target-app-versions.json" and "**/update.json".`,
    { cause: error },
  );
  nextError.name = "S3ArchivedObjectError";
  return nextError;
};

function normalizeBasePath(basePath?: string) {
  return basePath?.replace(/^\/+|\/+$/g, "") ?? "";
}

function createDatabaseKeyBuilder(basePath?: string) {
  const normalizedBasePath = normalizeBasePath(basePath);

  const toStorageKey = (key: string) =>
    [normalizedBasePath, key].filter(Boolean).join("/");

  const fromStorageKey = (key: string) => {
    if (!normalizedBasePath) return key;
    const prefix = `${normalizedBasePath}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  };

  return { fromStorageKey, toStorageKey };
}

function normalizeDirectoryPrefix(prefix: string) {
  if (!prefix) {
    return "";
  }

  return prefix.endsWith(S3_DIRECTORY_DELIMITER)
    ? prefix
    : `${prefix}${S3_DIRECTORY_DELIMITER}`;
}

function getRelativeDirectoryPrefix(prefix: string, rootPrefix: string) {
  if (!rootPrefix) {
    return prefix;
  }

  return prefix.startsWith(rootPrefix)
    ? prefix.slice(rootPrefix.length)
    : prefix;
}

function getDirectoryDepth(prefix: string, rootPrefix: string) {
  return getRelativeDirectoryPrefix(prefix, rootPrefix)
    .split(S3_DIRECTORY_DELIMITER)
    .filter(Boolean).length;
}

function getLastDirectorySegment(prefix: string) {
  const segments = prefix.split(S3_DIRECTORY_DELIMITER).filter(Boolean);
  return segments.at(-1);
}

function isPlatformDirectoryPrefix(prefix: string) {
  const lastSegment = getLastDirectorySegment(prefix);
  return lastSegment === "ios" || lastSegment === "android";
}

function isUpdateJsonKey(key: string) {
  return key.endsWith(`${S3_DIRECTORY_DELIMITER}update.json`);
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
) {
  const results: Array<TResult | undefined> = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;

        const item = items[index];
        if (item === undefined) {
          break;
        }

        results[index] = await mapper(item, index);
      }
    }),
  );

  return results.filter((result): result is TResult => result !== undefined);
}

/**
 * Loads JSON data from S3.
 * Returns null if NoSuchKey error occurs.
 */
async function loadJsonFromS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<T | null> {
  try {
    const { Body } = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!Body) return null;
    const bodyContents = await streamToString(Body);
    return JSON.parse(bodyContents) as T;
  } catch (e) {
    if (e instanceof NoSuchKey) return null;
    if (isArchivedS3ObjectError(e)) {
      throw createArchivedS3ObjectError({ bucket, key, error: e });
    }
    throw e;
  }
}

/**
 * Converts data to JSON string and uploads to S3.
 */
async function uploadJsonToS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
  data: T,
) {
  const Body = JSON.stringify(data);
  const ContentType = mime.getType(key) ?? "application/json";
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body,
      ContentType,
      CacheControl: "max-age=31536000",
    }),
  );
}

async function listObjectsInS3(
  client: S3Client,
  bucketName: string,
  prefix: string,
  rootPrefix = "",
) {
  const normalizedRootPrefix = normalizeDirectoryPrefix(rootPrefix);

  const listPrefix = async (currentPrefix: string) => {
    let continuationToken: string | undefined;
    const keys: string[] = [];
    const commonPrefixes = new Set<string>();

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: currentPrefix,
          Delimiter: S3_DIRECTORY_DELIMITER,
          ContinuationToken: continuationToken,
        }),
      );
      const found = (response.Contents ?? [])
        .map((item) => item.Key)
        .filter((key): key is string => !!key);
      keys.push(...found);

      for (const commonPrefix of response.CommonPrefixes ?? []) {
        if (commonPrefix.Prefix) {
          commonPrefixes.add(commonPrefix.Prefix);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return {
      commonPrefixes: Array.from(commonPrefixes),
      keys,
    };
  };

  const collectUpdateJsonKeys = async (
    currentPrefix: string,
  ): Promise<string[]> => {
    const { commonPrefixes, keys } = await listPrefix(currentPrefix);
    const depth = getDirectoryDepth(currentPrefix, normalizedRootPrefix);

    if (depth >= 2) {
      return [
        ...keys.filter(isUpdateJsonKey),
        ...commonPrefixes.map((commonPrefix) => `${commonPrefix}update.json`),
      ];
    }

    const nextPrefixes =
      depth === 1
        ? commonPrefixes.filter(isPlatformDirectoryPrefix)
        : commonPrefixes;
    const nestedKeys = await mapWithConcurrency(
      nextPrefixes,
      S3_LIST_OBJECTS_CONCURRENCY,
      (nextPrefix) => collectUpdateJsonKeys(nextPrefix),
    );
    return nestedKeys.flat();
  };

  const normalizedPrefix = normalizeDirectoryPrefix(prefix);
  return Array.from(new Set(await collectUpdateJsonKeys(normalizedPrefix)));
}

async function deleteObjectInS3(
  client: S3Client,
  bucketName: string,
  key: string,
) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
  );
}

/**
 * Invalidates CloudFront cache for the given paths.
 */
async function invalidateCloudFront(
  client: CloudFrontClient,
  distributionId: string,
  paths: string[],
  options?: {
    shouldWaitForInvalidation?: boolean;
  },
) {
  if (paths.length === 0) {
    return;
  }

  const timestamp = Date.now();
  try {
    const response = await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `invalidation-${timestamp}`,
          Paths: {
            Quantity: paths.length,
            Items: paths,
          },
        },
      }),
    );

    if (!options?.shouldWaitForInvalidation) {
      return;
    }

    const invalidationId = response.Invalidation?.Id;
    if (!invalidationId) {
      throw new Error(
        "CloudFront invalidation response is missing Invalidation.Id",
      );
    }

    if (response.Invalidation?.Status === "Completed") {
      return;
    }

    const timeoutMs = DEFAULT_INVALIDATION_TIMEOUT_MS;
    const pollIntervalMs = DEFAULT_INVALIDATION_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      const statusResponse = await client.send(
        new GetInvalidationCommand({
          DistributionId: distributionId,
          Id: invalidationId,
        }),
      );

      if (statusResponse.Invalidation?.Status === "Completed") {
        return;
      }
    }

    throw new Error(
      `Timed out waiting for CloudFront invalidation ${invalidationId} to complete after ${timeoutMs}ms`,
    );
  } catch (error) {
    if (options?.shouldWaitForInvalidation) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "Unknown invalidation error";
    console.warn(
      `[hot-updater/aws] CloudFront invalidation failed for distribution ${distributionId}; continuing without cache invalidation.`,
      {
        error: message,
        paths,
      },
    );
  }
}

export const s3Database = createBlobDatabasePlugin<S3DatabaseConfig>({
  name: "s3Database",
  connect: (config) => {
    const {
      basePath,
      bucketName,
      cloudfrontDistributionId,
      apiBasePath = "/api/check-update",
      shouldWaitForInvalidation = false,
      ...s3Config
    } = config;

    const client = new S3Client(applyS3RuntimeAwsConfig(s3Config));
    const { fromStorageKey, toStorageKey } = createDatabaseKeyBuilder(basePath);
    const rootPrefix = toStorageKey("");
    const cloudfrontClient = cloudfrontDistributionId
      ? new CloudFrontClient({
          credentials: s3Config.credentials,
          region: s3Config.region,
        })
      : undefined;

    return {
      apiBasePath,
      listObjects: (prefix: string) =>
        listObjectsInS3(
          client,
          bucketName,
          toStorageKey(prefix),
          rootPrefix,
        ).then((keys) => keys.map(fromStorageKey)),
      loadObject: (key: string) =>
        loadJsonFromS3(client, bucketName, toStorageKey(key)),
      uploadObject: (key: string, data) =>
        uploadJsonToS3(client, bucketName, toStorageKey(key), data),
      deleteObject: (key: string) =>
        deleteObjectInS3(client, bucketName, toStorageKey(key)),
      shouldSkipLoadObjectError: (error) =>
        error instanceof Error && error.name === "S3ArchivedObjectError",
      invalidatePaths: (pathsToInvalidate: string[]) => {
        if (
          cloudfrontClient &&
          cloudfrontDistributionId &&
          pathsToInvalidate.length > 0
        ) {
          return invalidateCloudFront(
            cloudfrontClient,
            cloudfrontDistributionId,
            pathsToInvalidate,
            {
              shouldWaitForInvalidation,
            },
          );
        }
        return Promise.resolve();
      },
    };
  },
});

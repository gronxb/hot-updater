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
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createBlobDatabasePlugin } from "@hot-updater/plugin-core";
import mime from "mime";
import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";
import { streamToString } from "./utils/streamToString";

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
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

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body,
      ContentType,
      CacheControl: "max-age=31536000",
    },
  });
  await upload.done();
}

async function listObjectsInS3(
  client: S3Client,
  bucketName: string,
  prefix: string,
) {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const found = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => !!key);
    keys.push(...found);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
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
  factory: (config) => {
    const {
      bucketName,
      cloudfrontDistributionId,
      apiBasePath = "/api/check-update",
      shouldWaitForInvalidation = false,
      ...s3Config
    } = config;

    const client = new S3Client(applyS3RuntimeAwsConfig(s3Config));
    const cloudfrontClient = cloudfrontDistributionId
      ? new CloudFrontClient({
          credentials: s3Config.credentials,
          region: s3Config.region,
        })
      : undefined;

    return {
      apiBasePath,
      listObjects: (prefix: string) =>
        listObjectsInS3(client, bucketName, prefix),
      loadObject: (key: string) => loadJsonFromS3(client, bucketName, key),
      uploadObject: (key: string, data) =>
        uploadJsonToS3(client, bucketName, key, data),
      deleteObject: (key: string) => deleteObjectInS3(client, bucketName, key),
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

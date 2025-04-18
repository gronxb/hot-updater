import {
  CloudFrontClient,
  CreateInvalidationCommand,
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
import type { DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createBlobDatabasePlugin } from "@hot-updater/plugin-core";
import mime from "mime";
import { streamToString } from "./utils/streamToString";

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
  cloudfrontDistributionId: string;
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
) {
  if (paths.length === 0) {
    return;
  }

  const timestamp = new Date().getTime();
  await client.send(
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
}

export const s3Database = (
  config: S3DatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const { bucketName, cloudfrontDistributionId, ...s3Config } = config;
  if (!cloudfrontDistributionId) {
    throw new Error("cloudfrontDistributionId is missing in s3Database");
  }
  const client = new S3Client(s3Config);
  const cloudfrontClient = new CloudFrontClient({
    credentials: s3Config.credentials,
    region: s3Config.region,
  });

  const litemItems = (prefix: string) =>
    listObjectsInS3(client, bucketName, prefix);

  function loadItem<T>(key: string) {
    return loadJsonFromS3<T>(client, bucketName, key);
  }

  function uploadItem<T>(key: string, data: T) {
    return uploadJsonToS3(client, bucketName, key, data);
  }

  function deleteItem(key: string) {
    return deleteObjectInS3(client, bucketName, key);
  }

  async function invalidatePaths(pathsToInvalidate: string[]) {
    // Execute CloudFront invalidation
    if (
      cloudfrontClient &&
      cloudfrontDistributionId &&
      pathsToInvalidate.length > 0
    ) {
      await invalidateCloudFront(
        cloudfrontClient,
        cloudfrontDistributionId,
        pathsToInvalidate,
      );
    }
  }

  return createBlobDatabasePlugin(
    bucketName,
    litemItems,
    loadItem,
    uploadItem,
    deleteItem,
    invalidatePaths,
    hooks,
  );
};

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

export interface AWSClients {
  s3Client: S3Client;
  cloudFrontClient: CloudFrontClient;
}

/**
 * Loads JSON data from S3.
 * Returns null if NoSuchKey error occurs.
 */
export async function loadJsonFromS3<T>(
  client: S3Client,
  bucket: string,
  key: string
): Promise<T | null> {
  try {
    const { Body } = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
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
export async function uploadJsonToS3<T>(
  client: S3Client,
  bucket: string,
  key: string,
  data: T
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

/**
 * Lists update.json keys for a given platform.
 *
 * - If a channel is provided, only that channel's update.json files are listed.
 * - Otherwise, all channels for the given platform are returned.
 */
export async function listUpdateJsonKeys(
  client: S3Client,
  bucketName: string,
  platform?: string,
  channel?: string
): Promise<string[]> {
  let continuationToken: string | undefined;
  const keys: string[] = [];
  const prefix = channel
    ? platform
      ? `${channel}/${platform}/`
      : `${channel}/`
    : "";
  // Use appropriate key format based on whether a channel is given.
  const pattern = channel
    ? platform
      ? new RegExp(`^${channel}/${platform}/[^/]+/update\\.json$`)
      : new RegExp(`^${channel}/[^/]+/[^/]+/update\\.json$`)
    : platform
    ? new RegExp(`^[^/]+/${platform}/[^/]+/update\\.json$`)
    : /^[^\/]+\/[^\/]+\/[^\/]+\/update\.json$/;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const found = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => !!key && pattern.test(key));
    keys.push(...found);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

export async function listObjects(
  client: S3Client,
  bucket: string,
) {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "",
        ContinuationToken: continuationToken,
      })
    );
    const found = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => !!key);
    keys.push(...found);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}
export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string
) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Invalidates CloudFront cache for the given paths.
 */
export async function invalidateCloudFront(
  client: CloudFrontClient,
  distributionId: string,
  paths: string[]
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
    })
  );
}

import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { DatabasePluginHooks } from "@hot-updater/plugin-core";
import { blobDatabase } from "./blobDatabase";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { streamToString } from "./utils/streamToString";
import mime from "mime";

export interface AWSClients {
  s3Client: S3Client;
  cloudFrontClient: CloudFrontClient;
}

export async function listObjects(config: AWSClients, bucket: string) {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = await config.s3Client.send(
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

export interface S3DatabaseConfig extends S3ClientConfig {
  bucketName: string;
  cloudfrontDistributionId: string;
}

export const s3Database = (
  config: S3DatabaseConfig,
  hooks?: DatabasePluginHooks
) => {
  const { bucketName, cloudfrontDistributionId, ...s3Config } = config;

  const awsConfig: AWSClients = {
    s3Client: new S3Client(s3Config),
    cloudFrontClient: new CloudFrontClient({
      credentials: s3Config.credentials,
      region: s3Config.region,
    }),
  };

  /**
   * Loads JSON data from S3.
   * Returns null if NoSuchKey error occurs.
   */
  async function loadJsonFromS3<T>(key: string): Promise<T | null> {
    try {
      const { Body } = await awsConfig.s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: key })
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
  async function uploadJsonToS3<T>(key: string, data: T) {
    const Body = JSON.stringify(data);
    const ContentType = mime.getType(key) ?? "application/json";
    const upload = new Upload({
      client: awsConfig.s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body,
        ContentType,
        CacheControl: "max-age=31536000",
      },
    });
    await upload.done();
  }

  async function listObjects() {
    let continuationToken: string | undefined;
    const keys: string[] = [];

    do {
      const response = await awsConfig.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
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

  async function deleteObject(key: string) {
    await awsConfig.s3Client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: key })
    );
  }

  async function postDoSomething(pathsToInvalidate: Set<string>) {
    // Execute CloudFront invalidation
    if (
      awsConfig.cloudFrontClient &&
      cloudfrontDistributionId &&
      pathsToInvalidate.size > 0
    ) {
      await invalidateCloudFront(
        awsConfig.cloudFrontClient,
        cloudfrontDistributionId,
        Array.from(pathsToInvalidate)
      );
    }
  }

  return blobDatabase(
    "s3Database",
    loadJsonFromS3,
    uploadJsonToS3,
    listObjects,
    deleteObject,
    postDoSomething,
    hooks
  );
};

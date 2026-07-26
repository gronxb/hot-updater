import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  StoragePluginError,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import { isAwsNotFound, mapAwsStorageError } from "./errors";
import { contentRangeFromS3, metadataFromS3, parseS3Uri } from "./objects";
import {
  assertS3Target,
  type S3OperationEnvironment,
} from "./operationEnvironment";
import { retainClientThroughStream } from "./stream";

type ReadOperations = Pick<StoragePluginImplementation, "get" | "head">;

export const createReadOperations = (
  environment: S3OperationEnvironment,
): ReadOperations => ({
  async head(input) {
    assertS3Target(input.context, environment.target);
    const lease = environment.owner.acquire(input.context);
    const { key } = parseS3Uri(input.storageUri, lease.config.bucketName);
    try {
      const output = await lease.client.send(
        new HeadObjectCommand({
          Bucket: lease.config.bucketName,
          Key: key,
        }),
        { abortSignal: input.signal },
      );
      return {
        kind: "found",
        storageUri: input.storageUri,
        metadata: metadataFromS3(output),
      };
    } catch (error) {
      if (isAwsNotFound(error)) {
        return { kind: "not-found" };
      }
      if (error instanceof Error) {
        throw mapAwsStorageError(error);
      }
      throw mapAwsStorageError(error);
    } finally {
      lease.release();
    }
  },
  async get(input) {
    assertS3Target(input.context, environment.target);
    const lease = environment.owner.acquire(input.context);
    const { key } = parseS3Uri(input.storageUri, lease.config.bucketName);
    try {
      const output = await lease.client.send(
        new GetObjectCommand({
          Bucket: lease.config.bucketName,
          Key: key,
          ...(input.range === undefined
            ? {}
            : {
                Range: `bytes=${input.range.start}-${input.range.end ?? ""}`,
              }),
        }),
        { abortSignal: input.signal },
      );
      if (output.Body === undefined) {
        throw new StoragePluginError(
          "integrity",
          "AWS S3 returned an empty object body.",
        );
      }
      const body = retainClientThroughStream(
        output.Body.transformToWebStream(),
        lease.release,
        input.signal,
      );
      return {
        kind: "found",
        storageUri: input.storageUri,
        body,
        metadata: metadataFromS3(output),
        ...(input.range === undefined
          ? {}
          : { range: contentRangeFromS3(output.ContentRange) }),
      };
    } catch (error) {
      lease.release();
      if (isAwsNotFound(error)) {
        return { kind: "not-found" };
      }
      if (error instanceof Error) {
        throw mapAwsStorageError(error);
      }
      throw mapAwsStorageError(error);
    }
  },
});

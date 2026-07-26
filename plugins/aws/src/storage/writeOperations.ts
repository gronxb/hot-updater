import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  StoragePluginError,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import {
  isAwsNotFound,
  isAwsPreconditionFailed,
  mapAwsStorageError,
} from "./errors";
import { createStorageKey, parseS3Uri } from "./objects";
import {
  assertS3Target,
  type S3OperationEnvironment,
} from "./operationEnvironment";

type WriteOperations = Pick<StoragePluginImplementation, "delete" | "put">;

export const createWriteOperations = (
  environment: S3OperationEnvironment,
): WriteOperations => ({
  async put(input) {
    assertS3Target(input.context, environment.target);
    if (input.signal?.aborted === true) {
      if (input.body instanceof ReadableStream) {
        await input.body.cancel();
      }
      throw new StoragePluginError("aborted", "AWS S3 put was aborted.");
    }
    const lease = environment.owner.acquire(input.context);
    const key = createStorageKey(lease.config.basePath, input.key);
    const storageUri = `s3://${lease.config.bucketName}/${key}`;
    try {
      await lease.client.send(
        new PutObjectCommand({
          Bucket: lease.config.bucketName,
          Key: key,
          Body:
            input.body instanceof Uint8Array
              ? input.body
              : Readable.fromWeb(input.body),
          ContentLength: input.contentLength,
          ...(input.contentType === undefined
            ? {}
            : { ContentType: input.contentType }),
          ...(input.metadata === undefined ? {} : { Metadata: input.metadata }),
          ...(input.condition === "create-only" ? { IfNoneMatch: "*" } : {}),
        }),
        { abortSignal: input.signal },
      );
      return { kind: "stored", storageUri };
    } catch (error) {
      if (input.condition === "create-only" && isAwsPreconditionFailed(error)) {
        return { kind: "already-exists", storageUri };
      }
      if (error instanceof Error) {
        throw mapAwsStorageError(error);
      }
      throw mapAwsStorageError(error);
    } finally {
      lease.release();
    }
  },
  async delete(input) {
    assertS3Target(input.context, environment.target);
    const lease = environment.owner.acquire(input.context);
    const { key } = parseS3Uri(input.storageUri, lease.config.bucketName);
    try {
      await lease.client.send(
        new HeadObjectCommand({
          Bucket: lease.config.bucketName,
          Key: key,
        }),
        { abortSignal: input.signal },
      );
      await lease.client.send(
        new DeleteObjectCommand({
          Bucket: lease.config.bucketName,
          Key: key,
        }),
        { abortSignal: input.signal },
      );
      return { kind: "deleted" };
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
});

import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  createStoragePlugin,
  StoragePluginError,
} from "@hot-updater/plugin-core/storage";

import { createR2ClientOwner } from "./nodeClient";
import { isR2Conflict, isR2NotFound, mapR2Error } from "./nodeErrors";
import { metadataFrom, rangeFrom } from "./nodeMetadata";
import type { R2NodeStorageConfig } from "./nodeTypes";
import { retainR2ClientThroughStream } from "./retainedStream";
import { createObjectKey, createR2Uri, parseR2Uri } from "./shared";

const assertNodeTarget = (target: string): void => {
  if (target !== "node") {
    throw new StoragePluginError(
      "invalid-input",
      'Cloudflare R2 Node storage requires context.target "node".',
    );
  }
};

export const r2Storage = (config: R2NodeStorageConfig) => {
  const owner = createR2ClientOwner(config);
  return createStoragePlugin({
    name: "r2Storage",
    protocol: "r2",
    plugin: () => ({
      async put(input) {
        assertNodeTarget(input.context.target);
        if (input.signal?.aborted === true) {
          if (input.body instanceof ReadableStream) {
            await input.body.cancel().then(undefined, () => undefined);
          }
          throw new StoragePluginError(
            "aborted",
            "Cloudflare R2 put was aborted.",
          );
        }
        const lease = owner.acquire(input.context);
        const key = createObjectKey(lease.config.basePath, input.key);
        const storageUri = createR2Uri(lease.config.bucketName, key);
        const body =
          input.body instanceof Uint8Array
            ? input.body
            : Readable.from(input.body);
        try {
          await lease.client.send(
            new PutObjectCommand({
              Bucket: lease.config.bucketName,
              Key: key,
              Body: body,
              ContentLength: input.contentLength,
              ...(input.contentType === undefined
                ? {}
                : { ContentType: input.contentType }),
              ...(input.metadata === undefined
                ? {}
                : { Metadata: input.metadata }),
              ...(input.condition === "create-only"
                ? { IfNoneMatch: "*" }
                : {}),
            }),
            { abortSignal: input.signal },
          );
          return { kind: "stored", storageUri };
        } catch (error) {
          if (input.condition === "create-only" && isR2Conflict(error)) {
            return { kind: "already-exists", storageUri };
          }
          if (error instanceof Error) {
            throw mapR2Error(error);
          }
          throw mapR2Error(error);
        } finally {
          lease.release();
        }
      },
      async head(input) {
        assertNodeTarget(input.context.target);
        const lease = owner.acquire(input.context);
        const key = parseR2Uri(input.storageUri, lease.config.bucketName);
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
            metadata: metadataFrom(output),
          };
        } catch (error) {
          if (isR2NotFound(error)) {
            return { kind: "not-found" };
          }
          if (error instanceof Error) {
            throw mapR2Error(error);
          }
          throw mapR2Error(error);
        } finally {
          lease.release();
        }
      },
      async get(input) {
        assertNodeTarget(input.context.target);
        const lease = owner.acquire(input.context);
        const key = parseR2Uri(input.storageUri, lease.config.bucketName);
        try {
          const output = await lease.client.send(
            new GetObjectCommand({
              Bucket: lease.config.bucketName,
              Key: key,
              ...(input.range === undefined
                ? {}
                : {
                    Range: `bytes=${input.range.start}-${
                      input.range.end ?? ""
                    }`,
                  }),
            }),
            { abortSignal: input.signal },
          );
          if (output.Body === undefined) {
            throw new StoragePluginError(
              "integrity",
              "Cloudflare R2 returned an empty object body.",
            );
          }
          return {
            kind: "found",
            storageUri: input.storageUri,
            body: retainR2ClientThroughStream(
              output.Body.transformToWebStream(),
              lease.release,
              input.signal,
            ),
            metadata: metadataFrom(output),
            ...(input.range === undefined
              ? {}
              : { range: rangeFrom(output.ContentRange) }),
          };
        } catch (error) {
          lease.release();
          if (isR2NotFound(error)) {
            return { kind: "not-found" };
          }
          if (error instanceof Error) {
            throw mapR2Error(error);
          }
          throw mapR2Error(error);
        }
      },
      async delete(input) {
        assertNodeTarget(input.context.target);
        const lease = owner.acquire(input.context);
        const key = parseR2Uri(input.storageUri, lease.config.bucketName);
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
          if (isR2NotFound(error)) {
            return { kind: "not-found" };
          }
          if (error instanceof Error) {
            throw mapR2Error(error);
          }
          throw mapR2Error(error);
        } finally {
          lease.release();
        }
      },
      async issueDownload(input) {
        assertNodeTarget(input.context.target);
        const lease = owner.acquire(input.context);
        const key = parseR2Uri(input.storageUri, lease.config.bucketName);
        try {
          if (lease.config.publicBaseUrl !== undefined) {
            const url = new URL(lease.config.publicBaseUrl);
            url.pathname = `${lease.config.bucketName}/${key}`;
            url.search = "";
            return { kind: "issued", downloadUrl: url.toString() };
          }
          return {
            kind: "issued",
            downloadUrl: await getSignedUrl(
              lease.client,
              new GetObjectCommand({
                Bucket: lease.config.bucketName,
                Key: key,
              }),
              { expiresIn: input.expiresInSeconds ?? 3600 },
            ),
          };
        } catch (error) {
          if (error instanceof Error) {
            throw mapR2Error(error);
          }
          throw mapR2Error(error);
        } finally {
          lease.release();
        }
      },
      onUnmount: owner.onUnmount,
    }),
  });
};

export type { R2NodeStorageConfig } from "./nodeTypes";

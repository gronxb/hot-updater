import {
  createStoragePlugin,
  StoragePluginError,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  firebaseNotFoundStatus,
  firebasePreconditionStatus,
  isFirebaseStatus,
  mapFirebaseError,
} from "./error";
import {
  assertFirebaseTarget,
  isLiteralFirebaseConfig,
  parseFirebaseObjectKey,
  resolveFirebaseConfig,
} from "./firebaseConfig";
import { throwIfAborted, wrapFirebaseStream } from "./stream";
import type {
  FirebaseStorageClientFactory,
  FirebaseStorageClientHandle,
  FirebaseStorageConfig,
} from "./types";

export const createFirebaseStorage = (
  config: FirebaseStorageConfig,
  target: "node" | "functions",
  createClient: FirebaseStorageClientFactory,
): StoragePlugin => {
  const literal = isLiteralFirebaseConfig(config);
  let cachedHandle: Promise<FirebaseStorageClientHandle> | undefined;

  const acquire = async (
    context: StorageOperationContext,
  ): Promise<FirebaseStorageClientHandle> => {
    assertFirebaseTarget(context, target);
    const resolved = resolveFirebaseConfig(config, context);
    if (!literal) {
      return createClient(resolved, "operation");
    }
    cachedHandle ??= createClient(resolved, "cached");
    return cachedHandle;
  };

  const release = async (
    handle: FirebaseStorageClientHandle,
  ): Promise<void> => {
    if (!literal) {
      await handle.close();
    }
  };

  return createStoragePlugin({
    name: "firebaseStorage",
    protocol: "gs",
    plugin: () => ({
      async put(input) {
        await throwIfAborted(
          input.signal,
          input.body instanceof ReadableStream ? input.body : undefined,
        );
        const handle = await acquire(input.context);
        const resolved = resolveFirebaseConfig(config, input.context);
        const key = [resolved.basePath, input.key].filter(Boolean).join("/");
        const storageUri = `gs://${resolved.storageBucket}/${key}`;
        try {
          await handle.client.put({
            key,
            body: input.body,
            contentLength: input.contentLength,
            contentType: input.contentType,
            metadata: input.metadata,
            createOnly: input.condition === "create-only",
            signal: input.signal,
          });
          return { kind: "stored", storageUri };
        } catch (error) {
          if (error instanceof Error) {
            if (
              input.condition === "create-only" &&
              isFirebaseStatus(error, firebasePreconditionStatus)
            ) {
              return { kind: "already-exists", storageUri };
            }
            throw mapFirebaseError(error);
          }
          throw mapFirebaseError(error);
        } finally {
          await release(handle);
        }
      },
      async head(input) {
        await throwIfAborted(input.signal);
        const handle = await acquire(input.context);
        const resolved = resolveFirebaseConfig(config, input.context);
        const key = parseFirebaseObjectKey(
          input.storageUri,
          resolved.storageBucket,
        );
        try {
          return {
            kind: "found",
            storageUri: input.storageUri,
            metadata: await handle.client.head(key),
          };
        } catch (error) {
          if (error instanceof Error) {
            if (isFirebaseStatus(error, firebaseNotFoundStatus)) {
              return { kind: "not-found" };
            }
            throw mapFirebaseError(error);
          }
          throw mapFirebaseError(error);
        } finally {
          await release(handle);
        }
      },
      async get(input) {
        await throwIfAborted(input.signal);
        const handle = await acquire(input.context);
        const resolved = resolveFirebaseConfig(config, input.context);
        const key = parseFirebaseObjectKey(
          input.storageUri,
          resolved.storageBucket,
        );
        try {
          const result = await handle.client.get(key, input.range);
          if (
            !Number.isSafeInteger(result.metadata.contentLength) ||
            result.metadata.contentLength < 0
          ) {
            throw new StoragePluginError(
              "provider",
              "Firebase Storage returned an invalid object length.",
            );
          }
          const rangeEnd =
            input.range?.end ?? result.metadata.contentLength - 1;
          if (
            input.range !== undefined &&
            (input.range.start >= result.metadata.contentLength ||
              rangeEnd >= result.metadata.contentLength)
          ) {
            throw new StoragePluginError(
              "invalid-input",
              "Firebase Storage byte range exceeds the object length.",
            );
          }
          const body = wrapFirebaseStream(result.body, input.signal, () =>
            release(handle),
          );
          return {
            kind: "found",
            storageUri: input.storageUri,
            body,
            metadata: result.metadata,
            ...(input.range === undefined
              ? {}
              : {
                  range: {
                    start: input.range.start,
                    end: rangeEnd,
                    totalLength: result.metadata.contentLength,
                  },
                }),
          };
        } catch (error) {
          await release(handle);
          if (error instanceof Error) {
            if (isFirebaseStatus(error, firebaseNotFoundStatus)) {
              return { kind: "not-found" };
            }
            throw mapFirebaseError(error);
          }
          throw mapFirebaseError(error);
        }
      },
      async delete(input) {
        await throwIfAborted(input.signal);
        const handle = await acquire(input.context);
        const resolved = resolveFirebaseConfig(config, input.context);
        const key = parseFirebaseObjectKey(
          input.storageUri,
          resolved.storageBucket,
        );
        try {
          await handle.client.delete(key);
          return { kind: "deleted" };
        } catch (error) {
          if (error instanceof Error) {
            if (isFirebaseStatus(error, firebaseNotFoundStatus)) {
              return { kind: "not-found" };
            }
            throw mapFirebaseError(error);
          }
          throw mapFirebaseError(error);
        } finally {
          await release(handle);
        }
      },
      async issueDownload(input) {
        await throwIfAborted(input.signal);
        const handle = await acquire(input.context);
        const resolved = resolveFirebaseConfig(config, input.context);
        const key = parseFirebaseObjectKey(
          input.storageUri,
          resolved.storageBucket,
        );
        const expiresAtMilliseconds =
          Date.now() + (input.expiresInSeconds ?? 3600) * 1000;
        try {
          return {
            kind: "issued",
            downloadUrl: await handle.client.issueDownload(
              key,
              expiresAtMilliseconds,
            ),
            expiresAt: new Date(expiresAtMilliseconds).toISOString(),
          };
        } catch (error) {
          if (error instanceof Error) {
            throw mapFirebaseError(error);
          }
          throw mapFirebaseError(error);
        } finally {
          await release(handle);
        }
      },
      async onUnmount() {
        if (cachedHandle !== undefined) {
          await (await cachedHandle).close();
        }
      },
    }),
  });
};

export type { FirebaseStorageConfig } from "./types";

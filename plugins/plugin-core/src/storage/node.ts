import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { StoragePluginError } from "../storage";
import type { NodeStoragePlugin } from "../types";
import type { StorageOperationContext, StoragePlugin } from "../types/storage";

export { createNodeStorageContext } from "./nodeContext";

export type NodeStorageContextSource =
  | StorageOperationContext
  | (() => StorageOperationContext);

export type BorrowedNodeStoragePlugin = Omit<NodeStoragePlugin, "onUnmount">;

const assertNever = (value: never): never => {
  throw new StoragePluginError(
    "provider",
    "Storage provider returned an invalid outcome.",
    { cause: value },
  );
};

const resolveContext = (
  contextSource: NodeStorageContextSource,
): StorageOperationContext => {
  const context =
    typeof contextSource === "function" ? contextSource() : contextSource;
  if (context.target !== "node") {
    throw new StoragePluginError(
      "invalid-input",
      'Node storage operations require context.target "node".',
    );
  }
  return context;
};

export const createNodeStoragePluginFacade = (
  plugin: StoragePlugin,
  contextSource: NodeStorageContextSource,
): BorrowedNodeStoragePlugin =>
  Object.freeze({
    name: plugin.name,
    supportedProtocol: plugin.protocol,
    profiles: Object.freeze({
      node: Object.freeze({
        async upload(key: string, filePath: string) {
          const context = resolveContext(contextSource);
          const file = await stat(filePath);
          const body = Readable.toWeb(createReadStream(filePath));
          try {
            const result = await plugin.put({
              context,
              key,
              body,
              contentLength: file.size,
            });
            return { storageUri: result.storageUri };
          } finally {
            await body.cancel().then(undefined, () => undefined);
          }
        },
        async exists(storageUri: string) {
          const context = resolveContext(contextSource);
          const result = await plugin.head({ context, storageUri });
          switch (result.kind) {
            case "found":
              return true;
            case "not-found":
              return false;
            default:
              return assertNever(result);
          }
        },
        async delete(storageUri: string) {
          const context = resolveContext(contextSource);
          await plugin.delete({ context, storageUri });
        },
        async downloadFile(storageUri: string, filePath: string) {
          const context = resolveContext(contextSource);
          const result = await plugin.get({ context, storageUri });
          switch (result.kind) {
            case "not-found":
              throw new StoragePluginError(
                "provider",
                `Storage object was not found: ${storageUri}.`,
              );
            case "found": {
              const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
              let completed = false;
              try {
                await pipeline(
                  Readable.fromWeb(result.body),
                  createWriteStream(temporaryPath, { flags: "wx" }),
                );
                await rename(temporaryPath, filePath);
                completed = true;
              } finally {
                if (!completed) {
                  await rm(temporaryPath, { force: true }).then(
                    undefined,
                    () => undefined,
                  );
                }
              }
              return;
            }
            default:
              return assertNever(result);
          }
        },
      }),
    }),
  });

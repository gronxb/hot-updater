import type { StoragePlugin } from "./types";

type RequireStorageOperations<
  TContext,
  TKey extends keyof StoragePlugin<TContext>,
> = StoragePlugin<TContext> & {
  [K in TKey]-?: NonNullable<StoragePlugin<TContext>[K]>;
};

const createMissingStorageOperationError = (
  plugin: Pick<StoragePlugin, "name" | "supportedProtocol">,
  operation: string,
) =>
  new Error(
    `${plugin.name} does not implement the ${operation} storage operation for protocol "${plugin.supportedProtocol}".`,
  );

export type UploadStoragePlugin<TContext = unknown> = RequireStorageOperations<
  TContext,
  "upload"
>;

export type DeleteStoragePlugin<TContext = unknown> = RequireStorageOperations<
  TContext,
  "delete"
>;

export type ReadTextStoragePlugin<TContext = unknown> =
  RequireStorageOperations<TContext, "readText">;

export type DownloadUrlStoragePlugin<TContext = unknown> =
  RequireStorageOperations<TContext, "getDownloadUrl">;

export type FileStoragePlugin<TContext = unknown> = RequireStorageOperations<
  TContext,
  "delete" | "downloadFile" | "exists" | "upload"
>;

export type RuntimeStorageOperations<TContext = unknown> =
  RequireStorageOperations<TContext, "getDownloadUrl" | "readText">;

export function assertStorageUpload<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is UploadStoragePlugin<TContext> {
  if (!plugin.upload) {
    throw createMissingStorageOperationError(plugin, "upload");
  }
}

export function assertStorageDelete<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is DeleteStoragePlugin<TContext> {
  if (!plugin.delete) {
    throw createMissingStorageOperationError(plugin, "delete");
  }
}

export function assertStorageReadText<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is ReadTextStoragePlugin<TContext> {
  if (!plugin.readText) {
    throw createMissingStorageOperationError(plugin, "readText");
  }
}

export function assertStorageGetDownloadUrl<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is DownloadUrlStoragePlugin<TContext> {
  if (!plugin.getDownloadUrl) {
    throw createMissingStorageOperationError(plugin, "getDownloadUrl");
  }
}

export function assertFileStoragePlugin<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is FileStoragePlugin<TContext> {
  for (const operation of [
    "delete",
    "downloadFile",
    "exists",
    "upload",
  ] as const) {
    if (!plugin[operation]) {
      throw createMissingStorageOperationError(plugin, operation);
    }
  }
}

export function assertRuntimeStorageOperations<TContext = unknown>(
  plugin: StoragePlugin<TContext>,
): asserts plugin is RuntimeStorageOperations<TContext> {
  for (const operation of ["getDownloadUrl", "readText"] as const) {
    if (!plugin[operation]) {
      throw createMissingStorageOperationError(plugin, operation);
    }
  }
}

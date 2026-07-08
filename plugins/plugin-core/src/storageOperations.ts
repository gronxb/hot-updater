import type { StoragePlugin } from "./types";

type RequireStorageOperations<TKey extends keyof StoragePlugin> =
  StoragePlugin & {
    [K in TKey]-?: NonNullable<StoragePlugin[K]>;
  };

const createMissingStorageOperationError = (
  plugin: Pick<StoragePlugin, "name" | "supportedProtocol">,
  operation: string,
) =>
  new Error(
    `${plugin.name} does not implement the ${operation} storage operation for protocol "${plugin.supportedProtocol}".`,
  );

export type UploadStoragePlugin = RequireStorageOperations<"upload">;

export type DeleteStoragePlugin = RequireStorageOperations<"delete">;

export type ReadTextStoragePlugin = RequireStorageOperations<"readText">;

export type DownloadUrlStoragePlugin =
  RequireStorageOperations<"getDownloadUrl">;

export type FileStoragePlugin = RequireStorageOperations<
  "delete" | "downloadFile" | "exists" | "upload"
>;

export type RuntimeStorageOperations = RequireStorageOperations<
  "getDownloadUrl" | "readText"
>;

export function assertStorageUpload(
  plugin: StoragePlugin,
): asserts plugin is UploadStoragePlugin {
  if (!plugin.upload) {
    throw createMissingStorageOperationError(plugin, "upload");
  }
}

export function assertStorageDelete(
  plugin: StoragePlugin,
): asserts plugin is DeleteStoragePlugin {
  if (!plugin.delete) {
    throw createMissingStorageOperationError(plugin, "delete");
  }
}

export function assertStorageReadText(
  plugin: StoragePlugin,
): asserts plugin is ReadTextStoragePlugin {
  if (!plugin.readText) {
    throw createMissingStorageOperationError(plugin, "readText");
  }
}

export function assertStorageGetDownloadUrl(
  plugin: StoragePlugin,
): asserts plugin is DownloadUrlStoragePlugin {
  if (!plugin.getDownloadUrl) {
    throw createMissingStorageOperationError(plugin, "getDownloadUrl");
  }
}

export function assertFileStoragePlugin(
  plugin: StoragePlugin,
): asserts plugin is FileStoragePlugin {
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

export function assertRuntimeStorageOperations(
  plugin: StoragePlugin,
): asserts plugin is RuntimeStorageOperations {
  for (const operation of ["getDownloadUrl", "readText"] as const) {
    if (!plugin[operation]) {
      throw createMissingStorageOperationError(plugin, operation);
    }
  }
}

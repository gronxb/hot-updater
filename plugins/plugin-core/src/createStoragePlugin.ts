import type { StoragePlugin } from "./types";

export type CreateStoragePluginOptions = StoragePlugin;

export type StorageOperation = Exclude<
  keyof StoragePlugin,
  "name" | "protocol"
>;

export type StoragePluginWith<TOperation extends StorageOperation> =
  StoragePlugin & Required<Pick<StoragePlugin, TOperation>>;

export const createStoragePlugin = <
  const TOptions extends CreateStoragePluginOptions,
>(
  options: TOptions,
): TOptions => ({ ...options });

export function assertStorageOperations<
  const TOperations extends readonly StorageOperation[],
>(
  plugin: StoragePlugin,
  operations: TOperations,
): asserts plugin is StoragePluginWith<TOperations[number]> {
  for (const operation of operations) {
    if (typeof plugin[operation] !== "function") {
      throw new Error(
        `Storage plugin "${plugin.name}" does not implement ${operation}.`,
      );
    }
  }
}

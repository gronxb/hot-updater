import type { StorageAdapter } from "./types";

export type CreateStorageAdapterOptions = StorageAdapter;

export type StorageOperation = Exclude<
  keyof StorageAdapter,
  "name" | "protocol"
>;

export type StorageAdapterWith<TOperation extends StorageOperation> =
  StorageAdapter & Required<Pick<StorageAdapter, TOperation>>;

export const createStorageAdapter = <
  const TOptions extends CreateStorageAdapterOptions,
>(
  options: TOptions,
): TOptions => ({ ...options });

export function assertStorageOperations<
  const TOperations extends readonly StorageOperation[],
>(
  adapter: StorageAdapter,
  operations: TOperations,
): asserts adapter is StorageAdapterWith<TOperations[number]> {
  for (const operation of operations) {
    if (typeof adapter[operation] !== "function") {
      throw new Error(
        `Storage adapter "${adapter.name}" does not implement ${operation}.`,
      );
    }
  }
}

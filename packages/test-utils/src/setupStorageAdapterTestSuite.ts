import {
  assertStorageOperations,
  type StorageAdapter,
  type StorageOperation,
} from "@hot-updater/plugin-core";
import { describe, it } from "vitest";

import { storageAdapterTestCases } from "./storageAdapterTestCases";

export interface StorageAdapterTestSuiteOptions {
  readonly name: string;
  /**
   * Returns the adapter over an empty bucket or base path. Every case creates
   * its own and calls `cleanup` after it.
   */
  readonly createStorage: () => Promise<{
    readonly storage: StorageAdapter;
    /**
     * The base path the adapter stores keys below. With it, every URI `put`
     * returns must have the key `<basePath>/<key>`.
     */
    readonly basePath?: string;
    readonly cleanup?: () => Promise<void>;
  }>;
  /**
   * The operations the adapter implements. The suite requires them, with
   * `put` and `get`, and skips the cases of every other operation. Without
   * it, the suite skips the cases of the operations the adapter lacks.
   */
  readonly operations?: readonly StorageOperation[];
}

/**
 * The storage adapter contract that deploy, patch, the Console, the server,
 * and `storage prune` rely on. Every official storage adapter runs it.
 */
export const setupStorageAdapterTestSuite = (
  options: StorageAdapterTestSuiteOptions,
): void => {
  const declared = options.operations;
  const required: readonly StorageOperation[] = [
    ...new Set<StorageOperation>(["put", "get", ...(declared ?? [])]),
  ];

  describe(`${options.name} storage adapter`, () => {
    it(`implements ${required.join(", ")}`, async () => {
      const { storage, cleanup } = await options.createStorage();
      try {
        assertStorageOperations(storage, required);
      } finally {
        await cleanup?.();
      }
    });

    for (const testCase of storageAdapterTestCases) {
      const undeclared =
        declared === undefined
          ? []
          : testCase.operations.filter(
              (operation) => !declared.includes(operation),
            );

      it.skipIf(undeclared.length > 0)(testCase.title, async (context) => {
        const { storage, basePath, cleanup } = await options.createStorage();
        try {
          const missing = testCase.operations.filter(
            (operation) => typeof storage[operation] !== "function",
          );
          if (declared === undefined && missing.length > 0) {
            context.skip(`${storage.name} lacks ${missing.join(", ")}`);
          }
          await testCase.run({ storage, basePath });
        } finally {
          await cleanup?.();
        }
      });
    }
  });
};

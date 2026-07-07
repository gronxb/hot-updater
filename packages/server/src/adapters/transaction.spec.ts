import type {
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginCore,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createCallbackDatabaseTransaction } from "./transaction";

const emptyPage = <TData>(): CursorPage<TData> => ({
  data: [],
  pagination: {
    currentPage: 1,
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
    total: 0,
    totalPages: 0,
  },
});

const createCore = (): DatabasePluginCore => ({
  bundlePatches: {
    delete: async () => undefined,
    getById: async () => null,
    insert: async () => undefined,
    list: async () => emptyPage<DatabaseBundlePatch>(),
    update: async () => undefined,
  },
  bundles: {
    delete: async () => undefined,
    getById: async () => null,
    insert: async () => undefined,
    list: async () => emptyPage<DatabaseBundleRecord>(),
    update: async () => undefined,
  },
});

describe("createCallbackDatabaseTransaction", () => {
  it("settles resources when the provider transaction fails before a handle is ready", async () => {
    const failure = new Error("begin failed");
    const onSettled = vi.fn(async () => undefined);

    await expect(
      createCallbackDatabaseTransaction({
        createCore,
        onSettled,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("keeps the provider transaction open until commit", async () => {
    const onSettled = vi.fn(async () => undefined);
    let operationCompleted = false;

    const transaction = await createCallbackDatabaseTransaction({
      createCore,
      onSettled,
      run: async (operation) => {
        await operation("tx");
        operationCompleted = true;
      },
    });

    expect(operationCompleted).toBe(false);
    await transaction.commit();

    expect(operationCompleted).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

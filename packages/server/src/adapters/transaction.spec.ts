import type { DatabasePluginDeclaration } from "@hot-updater/plugin-core/internal";
import { describe, expect, it, vi } from "vitest";

import { createCallbackDatabaseTransaction } from "./transaction";

const createConnection = (): DatabasePluginDeclaration => ({
  bundles: {
    delete: async () => undefined,
    findRecords: async () => [],
    getById: async () => null,
    insert: async () => undefined,
    update: async () => undefined,
  },
  patches: {
    storage: "embedded",
    findPatches: async () => [],
    getBundlePatches: async () => [],
    replaceBundlePatches: async () => undefined,
  },
});

describe("createCallbackDatabaseTransaction", () => {
  it("settles resources when the provider transaction fails before a handle is ready", async () => {
    const failure = new Error("begin failed");
    const onSettled = vi.fn(async () => undefined);

    await expect(
      createCallbackDatabaseTransaction({
        createConnection,
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
      createConnection,
      onSettled,
      run: async (operation) => {
        await operation("tx");
        operationCompleted = true;
      },
    });

    expect(transaction.connection).toMatchObject({
      patches: { storage: "embedded" },
    });
    expect(operationCompleted).toBe(false);
    await transaction.commit();

    expect(operationCompleted).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

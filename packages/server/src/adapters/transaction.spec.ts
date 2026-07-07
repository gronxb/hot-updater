import type { DatabasePluginCore } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createCallbackDatabaseTransaction } from "./transaction";

const createCore = (): DatabasePluginCore => ({
  bundlePatches: {
    count: async () => 0,
    delete: async () => undefined,
    findMany: async () => [],
    getById: async () => null,
    insert: async () => undefined,
    update: async () => undefined,
  },
  bundles: {
    count: async () => 0,
    delete: async () => undefined,
    findMany: async () => [],
    getById: async () => null,
    insert: async () => undefined,
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

import { describe, expect, it, vi } from "vitest";

import { createDatabaseAdapter } from "./createDatabaseAdapter";
import type { DatabaseAdapterImplementation } from "./types";

class UnimplementedAdapterMethodError extends Error {}

const unimplemented = async (): Promise<never> => {
  throw new UnimplementedAdapterMethodError();
};

const createMethods = () => ({
  create: unimplemented,
  update: unimplemented,
  delete: unimplemented,
  count: unimplemented,
  findOne: unimplemented,
  findMany: unimplemented,
});

describe("createDatabaseAdapter", () => {
  it("returns an adapter object from a directly configured adapter", () => {
    // Given
    const createMemoryAdapter = (name = "memory") =>
      createDatabaseAdapter({
        name,
        adapter: createMethods,
      });

    // When
    const adapter = createMemoryAdapter();

    // Then
    expect(typeof adapter).toBe("object");
    expect(adapter.name).toBe("memory");
  });

  it("composes onUnmount without invoking it", async () => {
    // Given
    const onUnmount = vi.fn(async () => undefined);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), onUnmount }),
    });

    expect(onUnmount).not.toHaveBeenCalled();

    // When
    const result = adapter.onUnmount?.();

    // Then
    await expect(result).resolves.toBeUndefined();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("forwards context to a callback-scoped transaction", async () => {
    // Given
    const context = { binding: "request-db" };
    const seenContexts: (typeof context)[] = [];
    const createImplementation = (): DatabaseAdapterImplementation<
      typeof context
    > => ({
      ...createMethods(),
      transaction: async (callback, transactionContext) => {
        if (transactionContext) {
          seenContexts.push(transactionContext);
        }
        return callback(createMethods());
      },
    });
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: createImplementation,
    });

    // When
    const result = await adapter.transaction?.(
      async () => "committed",
      context,
    );

    // Then
    expect(result).toBe("committed");
    expect(seenContexts).toEqual([context]);
  });

  it("propagates a transaction callback rejection", async () => {
    // Given
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        transaction: async (callback) => callback(createMethods()),
      }),
    });
    const rejection = new UnimplementedAdapterMethodError();

    // When
    const transaction = adapter.transaction?.(async () => {
      throw rejection;
    });

    // Then
    await expect(transaction).rejects.toBe(rejection);
  });

  it("passes default paging to findMany", async () => {
    // Given
    const inputs: { readonly limit?: number; readonly offset?: number }[] = [];
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        findMany: async (input) => {
          inputs.push(input);
          return [];
        },
      }),
    });

    // When
    await adapter.findMany({ model: "channels" });

    // Then
    expect(inputs).toEqual([{ model: "channels", limit: 100, offset: 0 }]);
  });

  it("passes select to the implementation and returns only selected fields", async () => {
    // Given
    const inputs: object[] = [];
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        findMany: async (input) => {
          inputs.push(input);
          return [{ id: "production" }];
        },
      }),
    });

    // When
    const rows = await adapter.findMany({
      model: "channels",
      select: ["id"],
    });

    // Then
    expect(inputs).toEqual([
      { model: "channels", select: ["id"], limit: 100, offset: 0 },
    ]);
    expect(rows).toEqual([{ id: "production" }]);
  });

  it("rejects invalid common operation inputs before provider execution", async () => {
    // Given
    const findMany = vi.fn(unimplemented);
    const deleteRows = vi.fn(unimplemented);
    const update = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        findMany,
        delete: deleteRows,
        update,
      }),
    });

    // When
    const emptySelect = adapter.findMany({ model: "channels", select: [] });
    const negativeLimit = adapter.findMany({ model: "channels", limit: -1 });
    const emptyDelete = adapter.delete({ model: "bundles", where: [] });
    const nonIdUpdate = adapter.update({
      model: "bundles",
      where: [{ field: "channel_id", value: "channel-production" }],
      update: { enabled: false },
    });

    // Then
    await expect(emptySelect).rejects.toMatchObject({
      code: "empty-select",
    });
    await expect(negativeLimit).rejects.toMatchObject({
      code: "invalid-pagination",
    });
    await expect(emptyDelete).rejects.toMatchObject({
      code: "empty-mutation-where",
    });
    await expect(nonIdUpdate).rejects.toMatchObject({
      code: "invalid-update-selector",
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

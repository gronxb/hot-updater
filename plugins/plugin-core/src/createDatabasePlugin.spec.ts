import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";

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

describe("createDatabasePlugin", () => {
  it("returns an adapter object when a provider is configured", () => {
    // Given
    const provider = createDatabasePlugin({
      name: "memory",
      factory: createMethods,
    });

    // When
    const adapter = provider({});

    // Then
    expect(typeof adapter).toBe("object");
    expect(adapter.name).toBe("memory");
  });

  it("composes lifecycle capabilities without invoking mutation hooks", async () => {
    // Given
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const onUnmount = vi.fn(async () => undefined);
    const provider = createDatabasePlugin({
      name: "memory",
      factory: () => ({ ...createMethods(), onUnmount }),
    });

    // When
    const adapter = provider({}, { onDatabaseUpdated });

    // Then
    expect(onDatabaseUpdated).not.toHaveBeenCalled();
    await expect(adapter.onDatabaseUpdated?.()).resolves.toBeUndefined();
    await expect(adapter.onUnmount?.()).resolves.toBeUndefined();
    expect(onDatabaseUpdated).toHaveBeenCalledOnce();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("forwards context to a callback-scoped transaction", async () => {
    // Given
    const context = { binding: "request-db" };
    const seenContexts: (typeof context)[] = [];
    const provider = createDatabasePlugin<
      Record<string, never>,
      typeof context
    >({
      name: "memory",
      factory: () => ({
        ...createMethods(),
        transaction: async (callback, transactionContext) => {
          if (transactionContext) {
            seenContexts.push(transactionContext);
          }
          return callback(createMethods());
        },
      }),
    });
    const adapter = provider({});

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
    const provider = createDatabasePlugin({
      name: "memory",
      factory: () => ({
        ...createMethods(),
        transaction: async (callback) => callback(createMethods()),
      }),
    });
    const adapter = provider({});
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
    const provider = createDatabasePlugin({
      name: "memory",
      factory: () => ({
        ...createMethods(),
        findMany: async (input) => {
          inputs.push(input);
          return [];
        },
      }),
    });
    const adapter = provider({});

    // When
    await adapter.findMany({ model: "channels" });

    // Then
    expect(inputs).toEqual([{ model: "channels", limit: 100, offset: 0 }]);
  });

  it("passes select to the implementation and returns only selected fields", async () => {
    // Given
    const inputs: object[] = [];
    const provider = createDatabasePlugin({
      name: "memory",
      factory: () => ({
        ...createMethods(),
        findMany: async (input) => {
          inputs.push(input);
          return [{ id: "production" }];
        },
      }),
    });
    const adapter = provider({});

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
    const provider = createDatabasePlugin({
      name: "memory",
      factory: () => ({
        ...createMethods(),
        findMany,
        delete: deleteRows,
        update,
      }),
    });
    const adapter = provider({});

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

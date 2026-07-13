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

const bundleRow = {
  id: "bundle-1",
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: "hash-1",
  git_commit_hash: null,
  message: null,
  channel: "production",
  channel_id: "channel-production",
  storage_uri: "storage://bundle-1.zip",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};

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
    const fractionalOffset = adapter.findMany({
      model: "channels",
      offset: 0.5,
    });
    const emptyDelete = adapter.delete({ model: "bundles", where: [] });
    const nonIdUpdate = adapter.update({
      model: "bundles",
      where: [{ field: "channel_id", value: "channel-production" }],
      update: { enabled: false },
    });
    const updateOperation: unknown = Reflect.get(adapter, "update");
    const createOperation: unknown = Reflect.get(adapter, "create");
    if (typeof createOperation !== "function") {
      throw new Error("Expected the adapter create operation.");
    }
    if (typeof updateOperation !== "function") {
      throw new Error("Expected the adapter update operation.");
    }

    // Then
    await expect(emptySelect).rejects.toMatchObject({
      code: "empty-select",
    });
    await expect(negativeLimit).rejects.toMatchObject({
      code: "invalid-pagination",
    });
    await expect(fractionalOffset).rejects.toMatchObject({
      code: "invalid-pagination",
    });
    await expect(emptyDelete).rejects.toMatchObject({
      code: "empty-mutation-where",
    });
    await expect(nonIdUpdate).rejects.toMatchObject({
      code: "invalid-update-selector",
    });
    await expect(
      createOperation({
        model: "bundles",
        data: { channel_id: "channel-staging" },
      }),
    ).rejects.toMatchObject({
      code: "incomplete-channel-create",
    });
    await expect(
      updateOperation({
        model: "bundles",
        where: [{ field: "id", value: "bundle-1" }],
        update: { channel: "staging" },
      }),
    ).rejects.toMatchObject({
      code: "incomplete-channel-update",
    });
    await expect(
      updateOperation({
        model: "bundles",
        where: [{ field: "id", value: "bundle-1" }],
        update: { channel_id: "channel-staging" },
      }),
    ).rejects.toMatchObject({
      code: "incomplete-channel-update",
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects runtime model and field injection before provider execution", async () => {
    const findMany = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), findMany }),
    });
    const findManyOperation: unknown = Reflect.get(adapter, "findMany");
    if (typeof findManyOperation !== "function") {
      throw new Error("Expected the adapter findMany operation.");
    }

    await expect(
      findManyOperation({ model: "bundles; DROP TABLE channels" }),
    ).rejects.toMatchObject({ code: "invalid-model" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "id) OR 1=1 --", value: "bundle-1" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-field" });
    await expect(
      findManyOperation({
        model: "bundles",
        sortBy: { field: "id DESC; DROP TABLE channels", direction: "asc" },
      }),
    ).rejects.toMatchObject({ code: "invalid-field" });
    await expect(
      findManyOperation({
        model: "bundles",
        sortBy: { field: "id", direction: "desc; DROP TABLE channels" },
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "id", value: { not: "bundle-keep" } }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "enabled", operator: "contains", value: true }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "id", operator: "in", value: ["bundle-1", {}] }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "metadata", value: { release: "stable" } }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        where: [{ field: "target_cohorts", value: null }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      findManyOperation({
        model: "bundles",
        sortBy: { field: "metadata", direction: "asc" },
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects invalid provider result values", async () => {
    const adapter = createDatabaseAdapter({
      name: "invalid-result",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => JSON.parse('{"id":42,"platform":"windows"}'),
      }),
    });

    await expect(
      adapter.findOne({
        model: "bundles",
        where: [{ field: "id", value: "bundle-1" }],
        select: ["id"],
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects invalid provider result containers and counts", async () => {
    const adapter = createDatabaseAdapter({
      name: "invalid-results",
      adapter: () => ({
        ...createMethods(),
        count: async () => -1,
        findOne: async () => JSON.parse("false"),
        findMany: async () => JSON.parse("null"),
      }),
    });

    await expect(
      adapter.findOne({
        model: "channels",
        where: [{ field: "id", value: "channel-production" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(adapter.findMany({ model: "channels" })).rejects.toMatchObject(
      { code: "invalid-result" },
    );
    await expect(adapter.count({ model: "bundles" })).rejects.toMatchObject({
      code: "invalid-result",
    });

    const updateAdapter = createDatabaseAdapter({
      name: "invalid-update-result",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => ({
          target_app_version: "1.0.0",
          fingerprint_hash: null,
        }),
        update: async () => JSON.parse("false"),
      }),
    });
    await expect(
      updateAdapter.update({
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        update: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects malformed target preflight rows as adapter errors", async () => {
    const adapter = createDatabaseAdapter({
      name: "invalid-target-result",
      adapter: () => ({
        ...createMethods(),
        findOne: async () => JSON.parse('"invalid"'),
      }),
    });

    await expect(
      adapter.update({
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        update: { fingerprint_hash: null },
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects unsupported operation and model pairs at runtime", async () => {
    const update = vi.fn(unimplemented);
    const deleteRows = vi.fn(unimplemented);
    const count = vi.fn(unimplemented);
    const findOne = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "operation-matrix",
      adapter: () => ({
        ...createMethods(),
        update,
        delete: deleteRows,
        count,
        findOne,
      }),
    });
    const updateOperation: unknown = Reflect.get(adapter, "update");
    const deleteOperation: unknown = Reflect.get(adapter, "delete");
    const countOperation: unknown = Reflect.get(adapter, "count");
    const findOneOperation: unknown = Reflect.get(adapter, "findOne");
    if (
      typeof updateOperation !== "function" ||
      typeof deleteOperation !== "function" ||
      typeof countOperation !== "function" ||
      typeof findOneOperation !== "function"
    ) {
      throw new Error("Expected database adapter operations.");
    }

    await expect(
      updateOperation({
        model: "channels",
        where: [{ field: "id", value: "channel-production" }],
        update: { name: "stable" },
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(
      deleteOperation({
        model: "channels",
        where: [{ field: "id", value: "channel-production" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(countOperation({ model: "channels" })).rejects.toMatchObject({
      code: "invalid-operation",
    });
    await expect(
      findOneOperation({
        model: "bundle_patches",
        where: [{ field: "id", value: "patch-1" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    expect(update).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it("rejects incomplete or invalid row values before provider execution", async () => {
    const create = vi.fn(unimplemented);
    const update = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), create, update }),
    });
    const createOperation: unknown = Reflect.get(adapter, "create");
    const updateOperation: unknown = Reflect.get(adapter, "update");
    if (
      typeof createOperation !== "function" ||
      typeof updateOperation !== "function"
    ) {
      throw new Error("Expected adapter mutation operations.");
    }

    await expect(
      createOperation({
        model: "bundles",
        data: { channel: "production", channel_id: "channel-production" },
        select: ["id"],
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    await expect(
      createOperation({
        model: "bundles",
        data: { ...bundleRow, channel_id: undefined },
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    await expect(
      updateOperation({
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        update: { channel: "production", channel_id: undefined },
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects bundles without a version or fingerprint before mutation", async () => {
    const create = vi.fn(unimplemented);
    const update = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        create,
        update,
        findOne: async (input) =>
          input.model === "bundles"
            ? { target_app_version: null, fingerprint_hash: "fingerprint" }
            : null,
      }),
    });

    await expect(
      adapter.create({
        model: "bundles",
        data: {
          ...bundleRow,
          target_app_version: null,
          fingerprint_hash: null,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    await expect(
      adapter.update({
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        update: { fingerprint_hash: null },
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects channel references whose id and legacy name disagree", async () => {
    const create = vi.fn(unimplemented);
    const update = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        create,
        update,
        findOne: async (input) =>
          input.model === "channels"
            ? { id: "channel-staging", name: "staging" }
            : null,
      }),
    });
    const createOperation: unknown = Reflect.get(adapter, "create");
    if (typeof createOperation !== "function") {
      throw new Error("Expected the adapter create operation.");
    }

    await expect(
      createOperation({
        model: "bundles",
        data: {
          ...bundleRow,
          channel: "production",
          channel_id: "channel-staging",
        },
      }),
    ).rejects.toMatchObject({ code: "channel-reference-mismatch" });
    await expect(
      adapter.update({
        model: "bundles",
        where: [{ field: "id", value: "bundle-1" }],
        update: {
          channel: "production",
          channel_id: "channel-staging",
        },
      }),
    ).rejects.toMatchObject({ code: "channel-reference-mismatch" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

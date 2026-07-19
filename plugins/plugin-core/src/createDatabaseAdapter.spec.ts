import { describe, expect, it, vi } from "vitest";

import { createDatabaseAdapter } from "./createDatabaseAdapter";
import {
  databaseAnalyticsSupport,
  type DatabaseAdapterImplementation,
} from "./types";

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

const bundleEventRow = {
  id: "01976b57-48d2-7e1b-8ee0-9cbf4b3f0001",
  type: "UPDATE_APPLIED" as const,
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: "bundle-0",
  to_bundle_id: "bundle-1",
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion" as const,
  fingerprint_hash: null,
  sdk_version: "0.37.0",
  received_at_ms: 1_725_000_000_000,
};

describe("createDatabaseAdapter", () => {
  it("returns an adapter object from a directly configured adapter", () => {
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: createMethods,
    });

    expect(typeof adapter).toBe("object");
    expect(adapter.name).toBe("memory");
  });

  it("advertises Analytics support for record adapters", () => {
    // Given
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: createMethods,
    });

    // When
    const capability = adapter[databaseAnalyticsSupport];

    // Then
    expect(capability).toBe(true);
  });

  it("calls the provider-native channel aggregate without request context", async () => {
    // Given
    const getChannels = vi.fn(async () => ["preview", "production"]);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), getChannels }),
    });

    // When
    const channels = await adapter.getChannels?.();

    // Then
    expect(channels).toEqual(["preview", "production"]);
    expect(getChannels).toHaveBeenCalledWith();
  });

  it("calls provider CRUD with only the record input", async () => {
    // Given
    const create = vi.fn(async () => bundleRow);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), create }),
    });
    const input = { model: "bundles", data: bundleRow } as const;

    // When
    await adapter.create(input);

    // Then
    expect(create).toHaveBeenCalledWith(input);
  });

  it("composes onUnmount without invoking it", async () => {
    const onUnmount = vi.fn(async () => undefined);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), onUnmount }),
    });

    expect(onUnmount).not.toHaveBeenCalled();
    await expect(adapter.onUnmount?.()).resolves.toBeUndefined();
    expect(onUnmount).toHaveBeenCalledOnce();
  });

  it("opens a callback-scoped transaction without request context", async () => {
    const calls: unknown[] = [];
    const transaction: NonNullable<
      DatabaseAdapterImplementation["transaction"]
    > = async (callback) => {
      calls.push(callback);
      return callback(createMethods());
    };
    const createImplementation = (): DatabaseAdapterImplementation => ({
      ...createMethods(),
      transaction,
    });
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: createImplementation,
    });

    const callback = async () => "committed";
    const result = await adapter.transaction?.(callback);

    expect(result).toBe("committed");
    expect(calls).toEqual([expect.any(Function)]);
  });

  it("passes default paging to findMany", async () => {
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

    await adapter.findMany({ model: "bundles" });

    expect(inputs).toEqual([{ model: "bundles", limit: 100, offset: 0 }]);
  });

  it("passes select and generic orderBy/distinctOn through findMany", async () => {
    const inputs: object[] = [];
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({
        ...createMethods(),
        findMany: async (input) => {
          inputs.push(input);
          return [
            { id: bundleEventRow.id, install_id: bundleEventRow.install_id },
          ];
        },
      }),
    });

    const rows = await adapter.findMany({
      model: "bundle_events",
      select: ["id", "install_id"],
      distinctOn: { fields: ["install_id"] },
      orderBy: [
        { field: "install_id", direction: "asc" },
        { field: "received_at_ms", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    });

    expect(inputs).toEqual([
      {
        model: "bundle_events",
        select: ["id", "install_id"],
        distinctOn: { fields: ["install_id"] },
        orderBy: [
          { field: "install_id", direction: "asc" },
          { field: "received_at_ms", direction: "desc" },
          { field: "id", direction: "desc" },
        ],
        limit: 100,
        offset: 0,
      },
    ]);
    expect(rows).toEqual([
      { id: bundleEventRow.id, install_id: bundleEventRow.install_id },
    ]);
  });

  it("rejects invalid common operation inputs before provider execution", async () => {
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

    await expect(
      adapter.findMany({ model: "bundles", select: [] }),
    ).rejects.toMatchObject({
      code: "empty-select",
    });
    await expect(
      adapter.findMany({ model: "bundles", limit: -1 }),
    ).rejects.toMatchObject({
      code: "invalid-pagination",
    });
    await expect(
      adapter.findMany({ model: "bundles", offset: 0.5 }),
    ).rejects.toMatchObject({
      code: "invalid-pagination",
    });
    await expect(
      adapter.delete({ model: "bundles", where: [] }),
    ).rejects.toMatchObject({
      code: "empty-mutation-where",
    });
    await expect(
      adapter.update({
        model: "bundles",
        where: [{ field: "channel", value: "production" }],
        update: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: "invalid-update-selector" });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects invalid orderBy and distinctOn combinations", async () => {
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), findMany: async () => [] }),
    });

    await expect(
      adapter.findMany({
        model: "bundles",
        orderBy: [{ field: "metadata" as "id", direction: "asc" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      adapter.findMany({
        model: "bundle_events",
        distinctOn: { fields: ["install_id"] },
      }),
    ).rejects.toMatchObject({ code: "invalid-distinct" });
    await expect(
      adapter.findMany({
        model: "bundle_events",
        distinctOn: { fields: ["install_id"] },
        orderBy: [{ field: "received_at_ms", direction: "desc" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-distinct" });
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
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects unsupported operation and model pairs at runtime", async () => {
    const adapter = createDatabaseAdapter({
      name: "operation-matrix",
      adapter: () => ({ ...createMethods() }),
    });
    const updateOperation = Reflect.get(adapter, "update") as Function;
    const deleteOperation = Reflect.get(adapter, "delete") as Function;

    await expect(
      updateOperation({
        model: "bundle_patches",
        where: [{ field: "id", value: "patch-1" }],
        update: { patch_storage_uri: "storage://patch-1" },
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(
      deleteOperation({
        model: "bundle_events",
        where: [{ field: "id", value: bundleEventRow.id }],
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
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

  it("validates bundle event rows and distinct counts", async () => {
    const adapter = createDatabaseAdapter({
      name: "event-memory",
      adapter: () => ({
        ...createMethods(),
        create: async (input) => input.data,
        count: async () => 1,
      }),
    });

    await expect(
      adapter.create({ model: "bundle_events", data: bundleEventRow }),
    ).resolves.toEqual(bundleEventRow);
    await expect(
      adapter.count({
        model: "bundle_events",
        where: [{ field: "type", value: "UPDATE_APPLIED" }],
        distinct: ["install_id"],
      }),
    ).resolves.toBe(1);
  });

  it("rejects incomplete or invalid row values before provider execution", async () => {
    const create = vi.fn(unimplemented);
    const update = vi.fn(unimplemented);
    const adapter = createDatabaseAdapter({
      name: "memory",
      adapter: () => ({ ...createMethods(), create, update }),
    });
    const createOperation = Reflect.get(adapter, "create") as Function;
    const updateOperation = Reflect.get(adapter, "update") as Function;

    await expect(
      createOperation({
        model: "bundles",
        data: { channel: "production" },
        select: ["id"],
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    await expect(
      updateOperation({
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        update: { channel: undefined },
      }),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

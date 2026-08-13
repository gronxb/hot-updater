import { describe, expect, it, vi } from "vitest";

import { createDatabasePluginCrud } from "./databasePluginCrud";
import type { DatabasePluginImplementation } from "./types/internal";

class MissingPluginOperationError extends Error {}

const unimplemented = async (): Promise<never> => {
  throw new MissingPluginOperationError();
};

const createMethods = () => ({
  create: unimplemented,
  update: unimplemented,
  delete: unimplemented,
  count: unimplemented,
  findOne: unimplemented,
  findMany: unimplemented,
  insertChannel: unimplemented,
  deleteChannel: unimplemented,
});

const createValidatedCrud = (options: {
  readonly name: string;
  readonly plugin: () => DatabasePluginImplementation;
}) => createDatabasePluginCrud(options.plugin());

const bundleRow = {
  id: "bundle-1",
  platform: "ios" as const,
  file_hash: "hash-1",
  git_commit_hash: null,
  storage_uri: "storage://bundle-1.zip",
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};

const invoke = (
  plugin: object,
  operation: string,
  input: unknown,
): Promise<unknown> => {
  const method: unknown = Reflect.get(plugin, operation);
  if (typeof method !== "function") throw new MissingPluginOperationError();
  return Promise.resolve(method(input));
};

describe("database plugin CRUD runtime contract", () => {
  it.each([
    { field: "id", operator: "ne", value: "bundle-1" },
    { field: "id", operator: "contains", value: "bundle" },
    { field: "id", operator: "in", value: ["bundle-1"] },
    { field: "id", operator: "gte", value: "bundle-1" },
    { field: "id", value: "bundle-1", connector: "AND" },
    { field: "id", value: "bundle-1", mode: "insensitive" },
  ])("rejects a non-exact bundle update selector: $operator", async (where) => {
    const update = vi.fn(async () => bundleRow);
    const plugin = createValidatedCrud({
      name: "selector-contract",
      plugin: () => ({ ...createMethods(), update }),
    });

    const result = invoke(plugin, "update", {
      model: "bundles",
      where: [where],
      update: { git_commit_hash: "next" },
    });

    await expect(result).rejects.toMatchObject({
      code: "invalid-update-selector",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    {
      model: "bundles",
      where: { field: "platform", operator: "in", value: ["windows"] },
    },
    {
      model: "releases",
      where: {
        field: "rollout_cohort_count",
        operator: "in",
        value: [-1],
      },
    },
    {
      model: "releases",
      where: {
        field: "rollout_cohort_count",
        operator: "in",
        value: [1.5],
      },
    },
  ])(
    "validates every in member against its field: $where.field",
    async ({ model, where }) => {
      const findMany = vi.fn(async () => []);
      const plugin = createValidatedCrud({
        name: "where-value-contract",
        plugin: () => ({ ...createMethods(), findMany }),
      });

      const result = invoke(plugin, "findMany", {
        model,
        where: [where],
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-query" });
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "id", value: "bundle-1", connector: "and" },
    { field: "id", value: "bundle-1", mode: "casefold" },
    { field: "rollout_cohort_count", value: 1, mode: "sensitive" },
    { field: "id", operator: "gt", value: "bundle-1", mode: "sensitive" },
    { field: "metadata", value: { release: "stable" } },
    { field: "platform", operator: "contains", value: "windows" },
  ])("rejects invalid where metadata: $field", async (where) => {
    const findMany = vi.fn(async () => []);
    const plugin = createValidatedCrud({
      name: "where-metadata-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    const result = invoke(plugin, "findMany", {
      model: where.field === "rollout_cohort_count" ? "releases" : "bundles",
      where: [where],
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects unknown create fields before provider execution", async () => {
    const create = vi.fn(async () => bundleRow);
    const plugin = createValidatedCrud({
      name: "create-shape-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    const result = invoke(plugin, "create", {
      model: "bundles",
      data: { ...bundleRow, unexpected: true },
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-field" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects duplicate order fields before provider execution", async () => {
    const findMany = vi.fn(async () => []);
    const plugin = createValidatedCrud({
      name: "order-by-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    const result = invoke(plugin, "findMany", {
      model: "bundles",
      orderBy: [
        { field: "id", direction: "asc" },
        { field: "id", direction: "desc" },
      ],
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-operation" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("forwards nonduplicate multi-field order clauses", async () => {
    const findMany = vi.fn(async () => []);
    const plugin = createValidatedCrud({
      name: "order-by-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });
    const orderBy = [
      { field: "platform", direction: "asc" as const },
      { field: "id", direction: "desc" as const },
    ];

    const result = await invoke(plugin, "findMany", {
      model: "bundles",
      orderBy,
    });

    expect(result).toEqual([]);
    expect(findMany).toHaveBeenCalledWith({
      model: "bundles",
      orderBy,
      limit: 100,
      offset: 0,
    });
  });

  it.each([
    null,
    [],
    "metadata",
    Number.NaN,
    1n,
    () => true,
    { nested: undefined },
    { nested: () => true },
    { nested: Symbol("metadata") },
    { app_version: 1 },
    { [Symbol("metadata")]: true },
  ])(
    "rejects non-JSON-object metadata before provider execution",
    async (metadata) => {
      const create = vi.fn(async () => bundleRow);
      const plugin = createValidatedCrud({
        name: "metadata-input-contract",
        plugin: () => ({ ...createMethods(), create }),
      });

      const result = invoke(plugin, "create", {
        model: "bundles",
        data: { ...bundleRow, metadata },
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-data" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("rejects cyclic metadata before provider execution", async () => {
    const metadata: Record<string, unknown> = {};
    metadata["self"] = metadata;
    const create = vi.fn(async () => bundleRow);
    const plugin = createValidatedCrud({
      name: "cyclic-metadata-input-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    const result = invoke(plugin, "create", {
      model: "bundles",
      data: { ...bundleRow, metadata },
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-data" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid metadata updates before provider execution", async () => {
    const update = vi.fn(async () => bundleRow);
    const plugin = createValidatedCrud({
      name: "metadata-update-contract",
      plugin: () => ({ ...createMethods(), update }),
    });

    const result = invoke(plugin, "update", {
      model: "bundles",
      where: [{ field: "id", value: bundleRow.id }],
      update: { metadata: { nested: Number.POSITIVE_INFINITY } },
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-data" });
    expect(update).not.toHaveBeenCalled();
  });

  it("forwards deeply nested JSON-object metadata unchanged", async () => {
    const metadata = {
      app_version: "1.0.0",
      release: {
        flags: [true, null, 3, "stable"],
      },
    };
    const create = vi.fn(async ({ data }) => data);
    const plugin = createValidatedCrud({
      name: "metadata-json-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    const result = await invoke(plugin, "create", {
      model: "bundles",
      data: { ...bundleRow, metadata },
    });

    expect(create).toHaveBeenCalledWith({
      model: "bundles",
      data: { ...bundleRow, metadata },
    });
    expect(result).toMatchObject({ metadata });
  });

  it("rejects inherited object property names as models", async () => {
    const findMany = vi.fn(async () => []);
    const plugin = createValidatedCrud({
      name: "model-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    const result = invoke(plugin, "findMany", { model: "toString" });

    await expect(result).rejects.toMatchObject({ code: "invalid-model" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects unsafe integer provider counts", async () => {
    const plugin = createValidatedCrud({
      name: "count-contract",
      plugin: () => ({
        ...createMethods(),
        count: async () => Number.MAX_SAFE_INTEGER + 1,
      }),
    });

    const result = plugin.count({ model: "bundles" });

    await expect(result).rejects.toMatchObject({ code: "invalid-result" });
  });

  it.each([
    { select: ["metadata"], row: {} },
    {
      select: undefined,
      row: Object.fromEntries(
        Object.entries(bundleRow).filter(([field]) => field !== "metadata"),
      ),
    },
  ])("requires every requested provider result field", async (fixture) => {
    const plugin = createValidatedCrud({
      name: "result-shape-contract",
      plugin: () => ({
        ...createMethods(),
        findOne: async () => fixture.row,
      }),
    });

    const result = invoke(plugin, "findOne", {
      model: "bundles",
      where: [{ field: "id", value: bundleRow.id }],
      ...(fixture.select === undefined ? {} : { select: fixture.select }),
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-result" });
  });

  it.each(["{}", { nested: () => true }])(
    "rejects malformed metadata returned by a provider",
    async (metadata) => {
      const returnedRow = { ...bundleRow };
      Reflect.set(returnedRow, "metadata", metadata);
      const plugin = createValidatedCrud({
        name: "metadata-result-contract",
        plugin: () => ({
          ...createMethods(),
          findOne: async () => returnedRow,
        }),
      });

      const result = invoke(plugin, "findOne", {
        model: "bundles",
        where: [{ field: "id", value: bundleRow.id }],
        select: ["metadata"],
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-result" });
    },
  );
});

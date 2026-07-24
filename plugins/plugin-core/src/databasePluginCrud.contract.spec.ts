import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";

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
    // Given
    const update = vi.fn(async () => bundleRow);
    const plugin = createDatabasePlugin({
      name: "selector-contract",
      plugin: () => ({ ...createMethods(), update }),
    });

    // When
    const result = invoke(plugin, "update", {
      model: "bundles",
      where: [where],
      update: { enabled: false },
    });

    // Then
    await expect(result).rejects.toMatchObject({
      code: "invalid-update-selector",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { field: "platform", operator: "in", value: ["windows"] },
    { field: "rollout_cohort_count", operator: "in", value: [-1] },
    { field: "rollout_cohort_count", operator: "in", value: [1.5] },
  ])("validates every in member against its field: $field", async (where) => {
    // Given
    const findMany = vi.fn(async () => []);
    const plugin = createDatabasePlugin({
      name: "where-value-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    // When
    const result = invoke(plugin, "findMany", {
      model: "bundles",
      where: [where],
    });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([
    { field: "id", value: "bundle-1", connector: "and" },
    { field: "id", value: "bundle-1", mode: "casefold" },
    { field: "rollout_cohort_count", value: 1, mode: "sensitive" },
    { field: "id", operator: "gt", value: "bundle-1", mode: "sensitive" },
    { field: "metadata", value: { release: "stable" } },
    { field: "platform", operator: "contains", value: "windows" },
  ])("rejects invalid where metadata: $field", async (where) => {
    // Given
    const findMany = vi.fn(async () => []);
    const plugin = createDatabasePlugin({
      name: "where-metadata-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    // When
    const result = invoke(plugin, "findMany", {
      model: "bundles",
      where: [where],
    });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects unknown create fields before provider execution", async () => {
    // Given
    const create = vi.fn(async () => bundleRow);
    const plugin = createDatabasePlugin({
      name: "create-shape-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    // When
    const result = invoke(plugin, "create", {
      model: "bundles",
      data: { ...bundleRow, unexpected: true },
    });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-field" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects inherited object property names as models", async () => {
    // Given
    const findMany = vi.fn(async () => []);
    const plugin = createDatabasePlugin({
      name: "model-contract",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    // When
    const result = invoke(plugin, "findMany", { model: "toString" });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-model" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects unsafe integer provider counts", async () => {
    // Given
    const plugin = createDatabasePlugin({
      name: "count-contract",
      plugin: () => ({
        ...createMethods(),
        count: async () => Number.MAX_SAFE_INTEGER + 1,
      }),
    });

    // When
    const result = plugin.count({ model: "bundles" });

    // Then
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
    // Given
    const plugin = createDatabasePlugin({
      name: "result-shape-contract",
      plugin: () => ({
        ...createMethods(),
        findOne: async () => fixture.row,
      }),
    });

    // When
    const result = invoke(plugin, "findOne", {
      model: "bundles",
      where: [{ field: "id", value: bundleRow.id }],
      ...(fixture.select === undefined ? {} : { select: fixture.select }),
    });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("validates the merged bundle target before update", async () => {
    // Given
    const update = vi.fn(async () => bundleRow);
    const plugin = createDatabasePlugin({
      name: "target-contract",
      plugin: () => ({
        ...createMethods(),
        findOne: async () => ({
          target_app_version: null,
          fingerprint_hash: "fingerprint-1",
        }),
        update,
      }),
    });

    // When
    const result = plugin.update({
      model: "bundles",
      where: [{ field: "id", value: bundleRow.id }],
      update: { fingerprint_hash: null },
    });

    // Then
    await expect(result).rejects.toMatchObject({ code: "invalid-data" });
    expect(update).not.toHaveBeenCalled();
  });
});

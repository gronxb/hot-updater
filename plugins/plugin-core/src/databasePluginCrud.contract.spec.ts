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
  recordInsights: unimplemented,
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
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};

const patchRow = {
  id: "patch-1",
  bundle_id: bundleRow.id,
  base_bundle_id: "base-1",
  base_file_hash: "base-hash",
  patch_file_hash: "patch-hash",
  patch_storage_uri: "storage://patch-1",
  byte_size: 3_000_000_002,
  order_index: 0,
};

const bundleEventRow = {
  id: "event-1",
  type: "UPDATE_APPLIED" as const,
  install_id: "install-1",
  user_id: null,
  username: null,
  from_release_id: null,
  from_bundle_id: "bundle-old",
  to_release_id: null,
  to_bundle_id: "bundle-new",
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "fingerprint" as const,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: 1,
};

const bundleInstallationRow = {
  id: bundleEventRow.id,
  install_id: bundleEventRow.install_id,
  user_id: bundleEventRow.user_id,
  username: bundleEventRow.username,
  to_bundle_id: bundleEventRow.to_bundle_id,
  type: bundleEventRow.type,
  platform: bundleEventRow.platform,
  app_version: bundleEventRow.app_version,
  channel: bundleEventRow.channel,
  cohort: bundleEventRow.cohort,
  received_at_ms: bundleEventRow.received_at_ms,
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

  it.each([
    ["bundles", bundleRow, "archive_byte_size"],
    ["bundle_patches", patchRow, "byte_size"],
  ] as const)(
    "rejects invalid required byte sizes for %s before provider execution",
    async (model, row, field) => {
      for (const value of [
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        "1",
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const create = vi.fn(async ({ data }) => data);
        const plugin = createValidatedCrud({
          name: "byte-size-input-contract",
          plugin: () => ({ ...createMethods(), create }),
        });

        const result = invoke(plugin, "create", {
          model,
          data: { ...row, [field]: value },
        });

        await expect(result).rejects.toMatchObject({ code: "invalid-data" });
        expect(create).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["bundles", { ...bundleRow, archive_byte_size: 0 }],
    ["bundle_patches", { ...patchRow, byte_size: Number.MAX_SAFE_INTEGER }],
  ] as const)("accepts boundary byte sizes for %s", async (model, data) => {
    const create = vi.fn(async ({ data: input }) => input);
    const plugin = createValidatedCrud({
      name: "byte-size-boundary-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    await expect(invoke(plugin, "create", { model, data })).resolves.toEqual(
      data,
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("accepts explicit null Release ids on an Insights event", async () => {
    const create = vi.fn(async ({ data }) => data);
    const plugin = createValidatedCrud({
      name: "insights-create-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    await expect(
      invoke(plugin, "create", {
        model: "bundle_events",
        data: bundleEventRow,
      }),
    ).resolves.toMatchObject({
      from_release_id: null,
      to_release_id: null,
    });
  });

  it.each(["from_release_id", "to_release_id"])(
    "rejects an omitted Insights create field: %s",
    async (field) => {
      const create = vi.fn(async ({ data }) => data);
      const plugin = createValidatedCrud({
        name: "insights-create-contract",
        plugin: () => ({ ...createMethods(), create }),
      });
      const data: Record<string, unknown> = { ...bundleEventRow };
      delete data[field];

      const result = invoke(plugin, "create", {
        model: "bundle_events",
        data,
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-data" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["bundle_events", "install_id", ""],
    ["bundle_events", "install_id", "i".repeat(256)],
    ["bundle_events", "user_id", ""],
    ["bundle_events", "user_id", "u".repeat(256)],
    ["bundle_installations", "install_id", ""],
    ["bundle_installations", "install_id", "i".repeat(256)],
    ["bundle_installations", "user_id", ""],
    ["bundle_installations", "user_id", "u".repeat(256)],
  ] as const)(
    "rejects invalid Insights identity %s.%s",
    async (model, field, value) => {
      const create = vi.fn(async ({ data }) => data);
      const plugin = createValidatedCrud({
        name: "insights-identity-contract",
        plugin: () => ({ ...createMethods(), create }),
      });
      const row =
        model === "bundle_events" ? bundleEventRow : bundleInstallationRow;

      const result = invoke(plugin, "create", {
        model,
        data: { ...row, [field]: value },
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-data" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(["bundle_events", "bundle_installations"] as const)(
    "accepts 255-character Insights identities for %s",
    async (model) => {
      const create = vi.fn(async ({ data }) => data);
      const plugin = createValidatedCrud({
        name: "insights-identity-contract",
        plugin: () => ({ ...createMethods(), create }),
      });
      const row =
        model === "bundle_events" ? bundleEventRow : bundleInstallationRow;
      const data = {
        ...row,
        install_id: "i".repeat(255),
        user_id: "u".repeat(255),
      };

      await expect(invoke(plugin, "create", { model, data })).resolves.toEqual(
        data,
      );
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each(["", "u".repeat(256)])(
    "rejects an invalid current user identity on installation update",
    async (userId) => {
      const update = vi.fn(async () => bundleInstallationRow);
      const plugin = createValidatedCrud({
        name: "insights-identity-contract",
        plugin: () => ({ ...createMethods(), update }),
      });
      const { install_id: _installId, ...validUpdate } = bundleInstallationRow;

      const result = invoke(plugin, "update", {
        model: "bundle_installations",
        where: [
          {
            field: "install_id",
            operator: "eq",
            value: bundleInstallationRow.install_id,
          },
          { field: "received_at_ms", operator: "lt", value: 2 },
        ],
        update: { ...validUpdate, user_id: userId },
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-data" });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { from_bundle_id: null },
    { to_bundle_id: null },
    {
      type: "UNCHANGED",
      from_bundle_id: "bundle-old",
      update_strategy: null,
    },
  ])("rejects an invalid Insights direction shape", async (overrides) => {
    const create = vi.fn(async ({ data }) => data);
    const plugin = createValidatedCrud({
      name: "insights-direction-contract",
      plugin: () => ({ ...createMethods(), create }),
    });

    const result = invoke(plugin, "create", {
      model: "bundle_events",
      data: { ...bundleEventRow, ...overrides },
    });

    await expect(result).rejects.toMatchObject({ code: "invalid-data" });
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
    ["bundles", "archive_byte_size", 3_000_000_001],
    ["bundle_patches", "byte_size", 3_000_000_002],
  ] as const)(
    "forwards numeric byte-size comparison and sorting for %s",
    async (model, field, value) => {
      const findMany = vi.fn(async () => []);
      const plugin = createValidatedCrud({
        name: "byte-size-query-contract",
        plugin: () => ({ ...createMethods(), findMany }),
      });
      const where = [{ field, operator: "gte" as const, value }];
      const orderBy = [{ field, direction: "desc" as const }];

      await expect(
        invoke(plugin, "findMany", { model, where, orderBy }),
      ).resolves.toEqual([]);
      expect(findMany).toHaveBeenCalledWith({
        model,
        where,
        orderBy,
        limit: 100,
        offset: 0,
      });
    },
  );

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

  it.each([
    ["bundles", bundleRow, "archive_byte_size"],
    ["bundle_patches", patchRow, "byte_size"],
  ] as const)(
    "rejects a %s provider result missing its required byte size",
    async (model, row, field) => {
      const returnedRow: Record<string, unknown> = { ...row };
      delete returnedRow[field];
      const plugin = createValidatedCrud({
        name: "byte-size-result-contract",
        plugin: () => ({
          ...createMethods(),
          findOne: async () => returnedRow,
        }),
      });

      const result = invoke(plugin, "findOne", {
        model,
        where: [{ field: "id", value: row.id }],
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-result" });
    },
  );

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

  it.each(["from_release_id", "to_release_id"])(
    "rejects an omitted Insights provider result field: %s",
    async (field) => {
      const row: Record<string, unknown> = { ...bundleEventRow };
      delete row[field];
      const plugin = createValidatedCrud({
        name: "insights-result-contract",
        plugin: () => ({
          ...createMethods(),
          findOne: async () => row,
        }),
      });

      const result = invoke(plugin, "findOne", {
        model: "bundle_events",
        where: [{ field: "id", value: bundleEventRow.id }],
      });

      await expect(result).rejects.toMatchObject({ code: "invalid-result" });
    },
  );
});

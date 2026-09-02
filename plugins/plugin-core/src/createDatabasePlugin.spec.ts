import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
  DatabaseAtomicCommitUnsupportedError,
  DatabasePluginInputError,
} from "./createDatabasePlugin";
import type {
  BundleEventRow,
  DatabaseChange,
  DatabaseCommit,
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "./types/internal";

class UnimplementedPluginMethodError extends Error {}

const unimplemented = async (): Promise<never> => {
  throw new UnimplementedPluginMethodError();
};

const createMethods = (): DatabasePluginImplementation => ({
  insights: {
    append: unimplemented,
    pageEvents: unimplemented,
    pageInstallations: unimplemented,
    getReport: unimplemented,
    pageReport: unimplemented,
  },
  create: unimplemented,
  update: unimplemented,
  delete: unimplemented,
  count: unimplemented,
  findOne: unimplemented,
  findMany: unimplemented,
  insertChannel: unimplemented,
  deleteChannel: unimplemented,
});

const createTransactionMethods =
  (): TransactionDatabasePluginImplementation => ({
    create: unimplemented,
    update: unimplemented,
    delete: unimplemented,
    count: unimplemented,
    findOne: unimplemented,
    findMany: unimplemented,
  });

const createTestPlugin = (
  name: string,
  implementation: DatabasePluginImplementation,
) =>
  createDatabasePlugin({
    name,
    ...createDatabasePluginAdapter(name, implementation),
  });

const channelRow = { id: "channel-1", name: "production" } as const;

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
} as const;

const releaseRow = {
  id: "00000000-0000-7000-8000-000000000001",
  revision: 1,
  scope_key: "v1:app-version:ios:cHJvZHVjdGlvbg",
  channel_id: channelRow.id,
  platform: "ios" as const,
  kind: "BUNDLE" as const,
  bundle_id: bundleRow.id,
  strategy: "APP_VERSION" as const,
  target_app_version: ">=1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY" as const,
  source_release_id: null,
  created_at_ms: 0,
  updated_at_ms: 0,
};

const eventRow: BundleEventRow = {
  id: "00000000-0000-7000-8000-000000000001",
  type: "UPDATE_APPLIED",
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: "bundle-old",
  from_release_id: null,
  to_bundle_id: "bundle-new",
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "0",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: 1,
};

describe("createDatabasePlugin", () => {
  it("exposes only models, commit, and lifecycle", () => {
    const plugin = createTestPlugin("memory", createMethods());

    expect(plugin.name).toBe("memory");
    expect(plugin.models.bundles.findById).toBeTypeOf("function");
    expect(plugin.models.bundlePatches.findByBundleIds).toBeTypeOf("function");
    expect(plugin.models.channels.insert).toBeTypeOf("function");
    expect(plugin.models.channels.delete).toBeTypeOf("function");
    expect(plugin.models.insights.append).toBeTypeOf("function");
    expect(plugin.models.insights.pageEvents).toBeTypeOf("function");
    expect(plugin.models.insights.pageInstallations).toBeTypeOf("function");
    expect(plugin.models.insights.getReport).toBeTypeOf("function");
    expect(plugin.models.insights.pageReport).toBeTypeOf("function");
    expect(plugin.models.apiKeys.findByHash).toBeTypeOf("function");
    expect(plugin.commit).toBeTypeOf("function");
    expect(Object.keys(plugin).sort()).toEqual(["commit", "models", "name"]);
    expect(Reflect.has(plugin, "queries")).toBe(false);
    expect(Reflect.has(plugin, "bundles")).toBe(false);
    expect(Reflect.has(plugin, "getChannels")).toBe(false);
    expect(Reflect.has(plugin, "transaction")).toBe(false);
  });

  it("validates the complete event contract before the append hook", async () => {
    const append = vi.fn(async () => {});
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      insights: { ...createMethods().insights, append },
    });
    const invalidRows = [
      { ...eventRow, id: "event-1" },
      { id: eventRow.id },
      {
        ...eventRow,
        extension: Array.from({ length: 21 }, () => "a".repeat(1000)),
      },
    ];

    for (const row of invalidRows) {
      await expect(
        plugin.models.insights.append(row as BundleEventRow),
      ).rejects.toMatchObject({ code: "invalid-data" });
    }
    expect(append).not.toHaveBeenCalled();

    const eventWithExtension = { ...eventRow, provider_extension: "retained" };
    await expect(
      plugin.models.insights.append(eventWithExtension),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(eventWithExtension);
  });

  it("canonicalizes and validates every Insights read at the adapter boundary", async () => {
    const failed = {
      state: "failed" as const,
      versions: {
        schemaVersion: null,
        storageVersion: null,
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "storage-not-ready" as const },
    };
    const pageEvents = vi.fn(async () => failed);
    const pageInstallations = vi.fn(async () => failed);
    const getReport = vi.fn(async () => failed);
    const pageReport = vi.fn(async () => failed);
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      insights: {
        append: unimplemented,
        pageEvents,
        pageInstallations,
        getReport,
        pageReport,
      },
    });

    await expect(
      plugin.models.insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 10,
        limit: 1,
      }),
    ).resolves.toEqual(failed);
    await expect(
      plugin.models.insights.pageInstallations({
        kind: "installationId",
        installId: "install-1",
        limit: 1,
      }),
    ).resolves.toEqual(failed);
    await expect(
      plugin.models.insights.getReport({
        query: {
          kind: "bundleSummaries",
          bundleIds: ["bundle-b", "bundle-a", "bundle-b"],
          window: "30d",
        },
      }),
    ).resolves.toEqual(failed);
    await expect(
      plugin.models.insights.pageReport({
        publicationId: "publication-1",
        section: "bundleDistribution",
        limit: 1,
      }),
    ).resolves.toEqual(failed);

    expect(pageEvents).toHaveBeenCalledOnce();
    expect(pageInstallations).toHaveBeenCalledOnce();
    expect(getReport).toHaveBeenCalledWith({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["bundle-a", "bundle-b"],
        window: "30d",
      },
    });
    expect(pageReport).toHaveBeenCalledOnce();

    await expect(
      plugin.models.insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 10,
        limit: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(pageEvents).toHaveBeenCalledOnce();
  });

  it("rejects an illegal Insights result state from the provider", async () => {
    const invalidPageEvents = (async () => ({
      state: "expired" as const,
      publicationId: "old",
    })) as unknown as DatabasePluginImplementation["insights"]["pageEvents"];
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      insights: {
        ...createMethods().insights,
        pageEvents: invalidPageEvents,
      },
    });

    await expect(
      plugin.models.insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 10,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("maps the domain bundle query to the low-level adapter", async () => {
    const findMany = vi.fn(async () => [bundleRow]);
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      findMany,
    });

    await expect(
      plugin.models.bundles.findMany({
        where: { platform: "ios", id: { gte: "a" } },
        limit: 20,
        offset: 40,
        orderBy: { field: "id", direction: "desc" },
      }),
    ).resolves.toEqual([bundleRow]);
    expect(findMany).toHaveBeenCalledWith({
      model: "bundles",
      where: [
        { field: "platform", value: "ios" },
        { field: "id", operator: "gte", value: "a" },
      ],
      limit: 20,
      offset: 40,
      orderBy: [{ field: "id", direction: "desc" }],
    });
  });

  it("lists channels only from channel storage in name order", async () => {
    const findMany = vi.fn(async (input) =>
      input.model === "channels"
        ? [
            { id: "channel-1", name: "production" },
            { id: "channel-2", name: "preview" },
          ]
        : [],
    );
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      findMany,
    });

    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [
        { id: "channel-2", name: "preview" },
        { id: "channel-1", name: "production" },
      ],
    });
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      model: "channels",
      limit: 100,
      offset: 0,
      orderBy: [{ field: "name", direction: "asc" }],
    });
  });

  it("returns the canonical channel selected by the provider", async () => {
    const canonical = { id: "canonical", name: "production" } as const;
    const insertChannel = vi.fn(async () => ({
      row: canonical,
      inserted: false,
    }));
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      insertChannel,
    });
    const input = {
      row: { id: "losing-candidate", name: "production" },
      onConflict: "returnExisting" as const,
    };

    await expect(plugin.models.channels.insert(input)).resolves.toEqual({
      row: canonical,
      inserted: false,
    });
    expect(insertChannel).toHaveBeenCalledWith(input);
  });

  it.each(["id", "name"] as const)(
    "accepts a Channel %s containing exactly 255 Unicode code points",
    async (field) => {
      const value = "😀".repeat(255);
      const row = { ...channelRow, [field]: value };
      const insertChannel = vi.fn(async () => ({
        row,
        inserted: true,
      }));
      const plugin = createTestPlugin("memory", {
        ...createMethods(),
        insertChannel,
      });

      await expect(
        plugin.models.channels.insert({
          row,
          onConflict: "returnExisting",
        }),
      ).resolves.toEqual({ row, inserted: true });
      expect(insertChannel).toHaveBeenCalledOnce();
    },
  );

  it.each(["id", "name"] as const)(
    "rejects a Channel %s containing 256 Unicode code points",
    async (field) => {
      const row = { ...channelRow, [field]: "😀".repeat(256) };
      const insertChannel = vi.fn(async () => ({
        row,
        inserted: true,
      }));
      const plugin = createTestPlugin("memory", {
        ...createMethods(),
        insertChannel,
      });

      await expect(
        plugin.models.channels.insert({
          row,
          onConflict: "returnExisting",
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(insertChannel).not.toHaveBeenCalled();
    },
  );

  it.each(["id", "name"] as const)(
    "rejects an empty Channel %s",
    async (field) => {
      const row = { ...channelRow, [field]: "" };
      const insertChannel = vi.fn(async () => ({
        row,
        inserted: true,
      }));
      const plugin = createTestPlugin("memory", {
        ...createMethods(),
        insertChannel,
      });

      await expect(
        plugin.models.channels.insert({
          row,
          onConflict: "returnExisting",
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(insertChannel).not.toHaveBeenCalled();
    },
  );

  it.each(["id", "name"] as const)(
    "enforces the 255-code-point Channel %s limit in generic commits",
    async (field) => {
      const acceptedRow = {
        ...channelRow,
        [field]: "😀".repeat(255),
      };
      const rejectedRow = {
        ...channelRow,
        [field]: "😀".repeat(256),
      };
      const create = vi.fn(async (input) => input.data);
      const plugin = createTestPlugin("memory", {
        ...createMethods(),
        create,
      });

      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: acceptedRow,
              onConflict: "ignore",
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      expect(create).toHaveBeenCalledOnce();

      create.mockClear();
      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: rejectedRow,
              onConflict: "ignore",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("delegates atomic referenced-channel deletion to the provider", async () => {
    const deleteChannel = vi.fn(async () => ({
      deleted: false as const,
      reason: "not_empty" as const,
    }));
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      deleteChannel,
    });

    await expect(
      plugin.models.channels.delete({ id: channelRow.id }),
    ).resolves.toEqual({ deleted: false, reason: "not_empty" });
    expect(deleteChannel).toHaveBeenCalledWith({ id: channelRow.id });
  });

  it.each(["", "😀".repeat(256)])(
    "rejects an invalid Channel delete identity before calling the provider",
    async (id) => {
      const deleteChannel = vi.fn(async () => ({ deleted: true as const }));
      const plugin = createTestPlugin("memory", {
        ...createMethods(),
        deleteChannel,
      });

      await expect(plugin.models.channels.delete({ id })).rejects.toEqual(
        new DatabasePluginInputError("invalid-data"),
      );
      expect(deleteChannel).not.toHaveBeenCalled();
    },
  );

  it("commits model changes in one adapter transaction", async () => {
    const create = vi.fn(async (input) => input.data);
    const findOne = vi.fn(async (input) =>
      input.model === "channels" ? channelRow : null,
    );
    const transaction = vi.fn(async (callback) =>
      callback({ ...createTransactionMethods(), create, findOne }),
    );
    const plugin = createTestPlugin("transactional", {
      ...createMethods(),
      transaction,
    });
    const changes = [
      {
        model: "channels",
        operation: "insert",
        row: channelRow,
        onConflict: "ignore",
      },
      { model: "bundles", operation: "insert", row: bundleRow },
      { model: "bundlePatches", operation: "insert", row: patchRow },
    ] as const satisfies readonly DatabaseChange[];

    await expect(plugin.commit({ changes })).resolves.toEqual({
      committed: true,
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([input]) => input.model)).toEqual([
      "channels",
      "bundles",
      "bundle_patches",
    ]);
  });

  it("returns an indexed conflict and aborts the transaction", async () => {
    const rollback = vi.fn();
    const transaction = vi.fn(async (callback) => {
      try {
        return await callback({
          ...createTransactionMethods(),
          update: async () => null,
        });
      } catch (error) {
        rollback();
        throw error;
      }
    });
    const plugin = createTestPlugin("transactional", {
      ...createMethods(),
      transaction,
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: bundleRow.id },
            update: { git_commit_hash: "next" },
          },
        ],
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 0, reason: "not_found" },
    });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rolls back a commit that deletes a referenced channel", async () => {
    const deleteRows = vi.fn(async () => undefined);
    const rollback = vi.fn();
    const transaction = vi.fn(async (callback) => {
      try {
        return await callback({
          ...createTransactionMethods(),
          count: async (input: { readonly model: string }) =>
            input.model === "releases" ? 1 : 0,
          delete: deleteRows,
        });
      } catch (error) {
        rollback();
        throw error;
      }
    });
    const plugin = createTestPlugin("transactional", {
      ...createMethods(),
      transaction,
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "delete",
            where: { id: channelRow.id },
          },
        ],
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 0, reason: "referenced" },
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it("rejects a multi-change commit before a non-atomic adapter mutates", async () => {
    const create = vi.fn(async (input) => input.data);
    const plugin = createTestPlugin("non-atomic", {
      ...createMethods(),
      create,
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: channelRow,
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row: bundleRow },
        ],
      }),
    ).rejects.toEqual(new DatabaseAtomicCommitUnsupportedError("non-atomic"));
    expect(create).not.toHaveBeenCalled();
  });

  it("uses an explicit provider-native commit", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createTestPlugin("native", {
      ...createMethods(),
      commit,
    });
    const input = { changes: [] } as const;

    await plugin.commit(input);

    expect(commit).toHaveBeenCalledWith(input);
  });

  it("rejects an invalid native commit envelope before calling the provider", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createTestPlugin("native", {
      ...createMethods(),
      commit,
    });

    await expect(
      plugin.commit(null as unknown as DatabaseCommit),
    ).rejects.toEqual(new DatabasePluginInputError("invalid-data"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a malformed native change before calling the provider", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createTestPlugin("native", {
      ...createMethods(),
      commit,
    });
    const input = {
      changes: [{ model: "channels", operation: "replace" }],
    } as unknown as DatabaseCommit;

    await expect(plugin.commit(input)).rejects.toBeInstanceOf(
      DatabasePluginInputError,
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("validates every native change, including Channel limits, before calling the provider", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createTestPlugin("native", {
      ...createMethods(),
      commit,
    });
    const input = {
      changes: [
        {
          model: "channels",
          operation: "insert",
          row: channelRow,
          onConflict: "ignore",
        },
        {
          model: "channels",
          operation: "insert",
          row: { id: "channel-2", name: "😀".repeat(256) },
          onConflict: "ignore",
        },
      ],
    } as const;

    await expect(plugin.commit(input)).rejects.toEqual(
      new DatabasePluginInputError("invalid-data"),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["id", "00000000-0000-4000-8000-000000000001"],
    ["id", "00000000-0000-7000-8000-00000000000A"],
    ["source_release_id", "00000000-0000-4000-8000-000000000001"],
  ] as const)(
    "rejects a non-canonical UUIDv7 Release %s before calling the provider",
    async (field, value) => {
      const commit = vi.fn(async () => ({ committed: true as const }));
      const plugin = createTestPlugin("native", {
        ...createMethods(),
        commit,
      });

      await expect(
        plugin.commit({
          changes: [
            {
              model: "releases",
              operation: "insert",
              row: { ...releaseRow, [field]: value },
            },
          ],
        }),
      ).rejects.toEqual(new DatabasePluginInputError("invalid-data"));
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid native Channel delete identity before calling the provider", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createTestPlugin("native", {
      ...createMethods(),
      commit,
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "delete",
            where: { id: "" },
          },
        ],
      }),
    ).rejects.toEqual(new DatabasePluginInputError("invalid-data"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("composes the optional lifecycle method", async () => {
    const dispose = vi.fn(async () => undefined);
    const plugin = createTestPlugin("memory", {
      ...createMethods(),
      dispose,
    });

    await expect(plugin.dispose?.()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePlugin,
  DatabaseAtomicCommitUnsupportedError,
} from "./createDatabasePlugin";
import type { DatabaseCommit, DatabasePluginImplementation } from "./types";

class UnimplementedPluginMethodError extends Error {}

const unimplemented = async (): Promise<never> => {
  throw new UnimplementedPluginMethodError();
};

const createMethods = (): DatabasePluginImplementation => ({
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

const insertWithPatch = {
  operation: "insert",
  bundleId: bundleRow.id,
  changes: [
    { table: "bundles", operation: "insert", row: bundleRow },
    {
      table: "bundle_patches",
      operation: "insert",
      row: {
        id: "patch-1",
        bundle_id: bundleRow.id,
        base_bundle_id: "base-1",
        base_file_hash: "base-hash",
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patch-1",
        order_index: 0,
      },
    },
  ],
} satisfies DatabaseCommit;

describe("createDatabasePlugin", () => {
  it("exposes named bundle and patch table ports", () => {
    const plugin = createDatabasePlugin({
      name: "memory",
      plugin: createMethods,
    });

    expect(plugin.name).toBe("memory");
    expect(plugin.bundles.findById).toBeTypeOf("function");
    expect(plugin.bundlePatches.findByBundleIds).toBeTypeOf("function");
    expect(plugin.commit).toBeTypeOf("function");
    expect(Reflect.has(plugin, "findMany")).toBe(false);
    expect(Reflect.has(plugin, "transaction")).toBe(false);
  });

  it("maps the domain bundle query to the low-level adapter", async () => {
    const findMany = vi.fn(async () => [bundleRow]);
    const plugin = createDatabasePlugin({
      name: "memory",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    await expect(
      plugin.bundles.findMany({
        where: { channel: "production", enabled: true, id: { gte: "a" } },
        limit: 20,
        offset: 40,
        orderBy: { field: "id", direction: "desc" },
      }),
    ).resolves.toEqual([bundleRow]);
    expect(findMany).toHaveBeenCalledWith({
      model: "bundles",
      where: [
        { field: "channel", value: "production" },
        { field: "enabled", value: true },
        { field: "id", operator: "gte", value: "a" },
      ],
      limit: 20,
      offset: 40,
      orderBy: [{ field: "id", direction: "desc" }],
    });
  });

  it("loads patch rows only through their owner ids", async () => {
    const findMany = vi.fn(async () => []);
    const plugin = createDatabasePlugin({
      name: "memory",
      plugin: () => ({ ...createMethods(), findMany }),
    });

    await plugin.bundlePatches.findByBundleIds(["owner-1", "owner-2"]);

    expect(findMany).toHaveBeenCalledWith({
      model: "bundle_patches",
      where: [
        {
          field: "bundle_id",
          operator: "in",
          value: ["owner-1", "owner-2"],
        },
      ],
      limit: 100,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });
  });

  it("uses an explicit bundle patch table port when provided", async () => {
    const findMany = vi.fn(async () => []);
    const findByBundleIds = vi.fn(async () => []);
    const plugin = createDatabasePlugin({
      name: "memory",
      plugin: () => ({ ...createMethods(), findMany }),
      bundlePatches: { findByBundleIds },
    });

    await plugin.bundlePatches.findByBundleIds(["owner-1", "owner-2"]);

    expect(findByBundleIds).toHaveBeenCalledWith(["owner-1", "owner-2"]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("commits bundle and patch table changes in one adapter transaction", async () => {
    const create = vi.fn(async (input) => input.data);
    const transaction = vi.fn(async (callback) =>
      callback({ ...createMethods(), create }),
    );
    const plugin = createDatabasePlugin({
      name: "transactional",
      plugin: () => ({ ...createMethods(), transaction }),
    });

    await expect(plugin.commit(insertWithPatch)).resolves.toEqual({
      applied: true,
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([input]) => input.model)).toEqual([
      "bundles",
      "bundle_patches",
    ]);
  });

  it("rejects a cross-table commit before a non-atomic adapter mutates", async () => {
    const create = vi.fn(async (input) => input.data);
    const plugin = createDatabasePlugin({
      name: "non-atomic",
      plugin: () => ({ ...createMethods(), create }),
    });

    await expect(plugin.commit(insertWithPatch)).rejects.toEqual(
      new DatabaseAtomicCommitUnsupportedError("non-atomic"),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("uses an explicit provider-native commit without hidden capabilities", async () => {
    const commit = vi.fn(async () => ({ applied: true }));
    const plugin = createDatabasePlugin({
      name: "native",
      plugin: () => ({ ...createMethods(), commit }),
    });

    await plugin.commit(insertWithPatch);

    expect(commit).toHaveBeenCalledWith(insertWithPatch);
  });

  it("composes optional lifecycle and fast-path methods", async () => {
    const getChannels = vi.fn(async () => ["preview", "production"]);
    const onUnmount = vi.fn(async () => undefined);
    const plugin = createDatabasePlugin({
      name: "memory",
      plugin: () => ({ ...createMethods(), getChannels, onUnmount }),
    });

    await expect(plugin.getChannels?.()).resolves.toEqual([
      "preview",
      "production",
    ]);
    await expect(plugin.onUnmount?.()).resolves.toBeUndefined();
    expect(onUnmount).toHaveBeenCalledOnce();
  });
});

import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import { createDatabasePlugin } from "./createDatabasePlugin";
import {
  createDatabaseClient,
  DatabaseBundleNotFoundError,
  DatabasePatchInsertUnsupportedError,
  DatabasePatchUpdateUnsupportedError,
} from "./databaseClient";
import { bundleToRow } from "./databaseRows";
import type { DatabasePluginImplementation } from "./types";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

const createNativePlugin = (
  commit: NonNullable<DatabasePluginImplementation["commit"]>,
  onDatabaseUpdated?: () => Promise<void>,
) => ({
  ...createDatabasePlugin({
    name: "native-aggregate",
    plugin: () => ({
      create: async (input) => input.data,
      update: async () => null,
      delete: async () => undefined,
      count: async () => 0,
      findOne: async () => null,
      findMany: async () => [],
      commit,
    }),
  }),
  ...(onDatabaseUpdated ? { onDatabaseUpdated } : {}),
});

const createBlobFixture = async () => {
  const store = new Map<string, unknown>();
  const plugin = createBlobDatabasePlugin({
    name: "patch-update",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => store.get(key) ?? null,
      uploadObject: async (key, value) => void store.set(key, value),
      compareAndSwapObject: async (key, expected, value) => {
        if (
          JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
        ) {
          return false;
        }
        store.set(key, value);
        return true;
      },
      invalidatePaths: async () => undefined,
    }),
  });
  const client = createDatabaseClient(plugin);
  const base = createBundle("base");
  const owner = {
    ...createBundle("owner"),
    patches: [
      {
        baseBundleId: base.id,
        baseFileHash: base.fileHash,
        patchFileHash: "patch-hash",
        patchStorageUri: "storage://patch",
      },
    ],
  } satisfies Bundle;
  await client.insertBundle(base);
  await client.insertBundle(owner);
  return { client, owner };
};

describe("database client patch updates", () => {
  it("rejects patch insertion before mutating a non-transaction provider", async () => {
    const create = vi.fn(async (input) => input.data);
    const plugin = createDatabasePlugin({
      name: "non-transaction",
      plugin: () => ({
        create,
        update: async () => null,
        delete: async () => undefined,
        count: async () => 0,
        findOne: async () => null,
        findMany: async () => [],
      }),
    });
    const base = createBundle("base");
    const owner = {
      ...createBundle("owner"),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
        },
      ],
    } satisfies Bundle;

    const result = createDatabaseClient(plugin).insertBundle(owner);

    await expect(result).rejects.toMatchObject({
      name: "DatabasePatchInsertUnsupportedError",
      bundleId: "owner",
      pluginName: "non-transaction",
    } satisfies Partial<DatabasePatchInsertUnsupportedError>);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects patch replacement before mutating a non-transaction provider", async () => {
    const row = bundleToRow(createBundle("owner"));
    let scalarUpdateCount = 0;
    let patchDeleteCount = 0;
    const plugin = createDatabasePlugin({
      name: "non-transaction",
      plugin: () => ({
        create: async (input) => input.data,
        update: async () => {
          scalarUpdateCount += 1;
          return row;
        },
        delete: async (input) => {
          if (input.model === "bundle_patches") patchDeleteCount += 1;
        },
        count: async () => 1,
        findOne: async (input) => (input.model === "bundles" ? row : null),
        findMany: async () => [],
      }),
    });

    const result = createDatabaseClient(plugin).updateBundleById("owner", {
      enabled: false,
      patches: [],
    });

    await expect(result).rejects.toMatchObject({
      name: "DatabasePatchUpdateUnsupportedError",
      bundleId: "owner",
      pluginName: "non-transaction",
    } satisfies Partial<DatabasePatchUpdateUnsupportedError>);
    expect(scalarUpdateCount).toBe(0);
    expect(patchDeleteCount).toBe(0);
  });

  it("uses a provider-native atomic aggregate without exposing a transaction", async () => {
    const commit = vi.fn(async () => ({ applied: true }));
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const plugin = createNativePlugin(commit, onDatabaseUpdated);
    const owner = {
      ...createBundle("owner"),
      patches: [
        {
          baseBundleId: "base",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
        },
      ],
    } satisfies Bundle;

    await createDatabaseClient(plugin).insertBundle(owner);

    expect(plugin.commitBatch).toBeUndefined();
    expect(commit).toHaveBeenCalledWith({
      operation: "insert",
      bundleId: "owner",
      changes: [
        { table: "bundles", operation: "insert", row: bundleToRow(owner) },
        {
          table: "bundle_patches",
          operation: "insert",
          row: {
            base_bundle_id: "base",
            base_file_hash: "base-hash",
            bundle_id: "owner",
            id: "owner:base",
            order_index: 0,
            patch_file_hash: "patch-hash",
            patch_storage_uri: "storage://patch",
          },
        },
      ],
    });
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("rejects explicit null metadata before a provider-native aggregate update", async () => {
    const commit = vi.fn(async () => ({ applied: true }));
    const plugin = createNativePlugin(commit);
    const update: Partial<Bundle> = { patches: [] };
    Reflect.set(update, "metadata", null);

    const result = createDatabaseClient(plugin).updateBundleById(
      "owner",
      update,
    );

    await expect(result).rejects.toMatchObject({ code: "invalid-data" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves provider-native aggregates inside a transactionless batch", async () => {
    const commit = vi.fn(async () => ({ applied: true }));
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const plugin = createNativePlugin(commit, onDatabaseUpdated);
    const owner = {
      ...createBundle("owner"),
      patches: [
        {
          baseBundleId: "base",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
        },
      ],
    } satisfies Bundle;

    await createDatabaseClient(plugin).mutate(async (database) => {
      await database.insertBundle(owner);
      await database.updateBundleById(owner.id, {
        enabled: false,
        patches: [],
      });
    });

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "update",
        bundleId: "owner",
        changes: expect.arrayContaining([
          expect.objectContaining({
            table: "bundles",
            operation: "update",
            update: { enabled: false },
          }),
          expect.objectContaining({
            table: "bundle_patches",
            operation: "delete",
            bundleId: "owner",
          }),
        ]),
      }),
    );
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("does not report a native aggregate failure as a completed update", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const plugin = createNativePlugin(
      async () => ({ applied: false }),
      onDatabaseUpdated,
    );

    const result = createDatabaseClient(plugin).updateBundleById("missing", {
      enabled: false,
      patches: [],
    });

    await expect(result).rejects.toMatchObject({
      name: "DatabaseBundleNotFoundError",
      bundleId: "missing",
    } satisfies Partial<DatabaseBundleNotFoundError>);
    expect(onDatabaseUpdated).not.toHaveBeenCalled();
  });

  it("does not report a rejected native aggregate insert as completed", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const failure = new Error("atomic insert failed");
    const plugin = createNativePlugin(async () => {
      throw failure;
    }, onDatabaseUpdated);
    const owner = {
      ...createBundle("owner"),
      patches: [
        {
          baseBundleId: "base",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "storage://patch",
        },
      ],
    } satisfies Bundle;

    await expect(
      createDatabaseClient(plugin).mutate((database) =>
        database.insertBundle(owner),
      ),
    ).rejects.toBe(failure);
    expect(onDatabaseUpdated).not.toHaveBeenCalled();
  });

  it("leaves patch rows untouched when patches are omitted", async () => {
    const { client, owner } = await createBlobFixture();

    await client.updateBundleById(owner.id, { message: "new" });

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      message: "new",
      patches: owner.patches,
    });
  });

  it("clears patch rows when patches are present and empty", async () => {
    const { client, owner } = await createBlobFixture();

    await client.updateBundleById(owner.id, { patches: [] });

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });

  it("reuses an active aggregate transaction for patch replacement", async () => {
    const { client, owner } = await createBlobFixture();

    await client.mutate((transaction) =>
      transaction.updateBundleById(owner.id, { patches: [] }),
    );

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });
});

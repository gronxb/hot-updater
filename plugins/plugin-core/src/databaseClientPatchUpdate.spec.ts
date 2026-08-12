import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
} from "./createDatabasePlugin";
import {
  createDatabaseClient,
  DatabaseBundleNotFoundError,
  DatabasePatchInsertUnsupportedError,
  DatabasePatchUpdateUnsupportedError,
} from "./databaseClient";
import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import { bundleToRow } from "./databaseRows";
import type { DatabasePluginImplementation } from "./types/internal";

const channelRow = { id: "channel-production", name: "production" } as const;

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
) => {
  const name = "native-aggregate";
  return createDatabasePlugin({
    name,
    ...createDatabasePluginAdapter(name, {
      create: async (input) => input.data,
      update: async () => null,
      delete: async () => undefined,
      count: async () => 0,
      findOne: async () => null,
      findMany: async () => [],
      insertChannel: async () => ({ row: channelRow, inserted: false }),
      deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      commit,
    }),
  });
};

const createMemoryFixture = async () => {
  const plugin = createMemoryDatabasePlugin();
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
    const name = "non-transaction";
    const plugin = createDatabasePlugin({
      name,
      ...createDatabasePluginAdapter(name, {
        create,
        update: async () => null,
        delete: async () => undefined,
        count: async () => 0,
        findOne: async () => null,
        findMany: async () => [],
        insertChannel: async () => ({ row: channelRow, inserted: false }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
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
    const row = bundleToRow(createBundle("owner"), channelRow.id);
    let scalarUpdateCount = 0;
    let patchDeleteCount = 0;
    const name = "non-transaction";
    const plugin = createDatabasePlugin({
      name,
      ...createDatabasePluginAdapter(name, {
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
        insertChannel: async () => ({ row: channelRow, inserted: false }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
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
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createNativePlugin(commit);
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

    expect(commit).toHaveBeenCalledWith({
      changes: [
        {
          model: "bundles",
          operation: "insert",
          row: bundleToRow(owner, channelRow.id),
        },
        {
          model: "bundlePatches",
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
  });

  it("rejects explicit null metadata before a provider-native aggregate update", async () => {
    const commit = vi.fn(async () => ({ committed: true as const }));
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
    const commit = vi.fn(async () => ({ committed: true as const }));
    const plugin = createNativePlugin(commit);
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

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({
      changes: [
        expect.objectContaining({
          model: "bundles",
          operation: "insert",
          row: expect.objectContaining({ id: "owner" }),
        }),
        expect.objectContaining({
          model: "bundlePatches",
          operation: "insert",
        }),
        expect.objectContaining({
          operation: "update",
          model: "bundles",
          where: { id: "owner" },
          update: { enabled: false },
        }),
        expect.objectContaining({
          model: "bundlePatches",
          operation: "delete",
          where: { bundleId: "owner" },
        }),
      ],
    });
  });

  it("does not report a native aggregate failure as a completed update", async () => {
    const plugin = createNativePlugin(async () => ({
      committed: false,
      conflict: { changeIndex: 0, reason: "not_found" },
    }));

    const result = createDatabaseClient(plugin).updateBundleById("missing", {
      enabled: false,
      patches: [],
    });

    await expect(result).rejects.toMatchObject({
      name: "DatabaseBundleNotFoundError",
      bundleId: "missing",
    } satisfies Partial<DatabaseBundleNotFoundError>);
  });

  it("does not report a rejected native aggregate insert as completed", async () => {
    const failure = new Error("atomic insert failed");
    const plugin = createNativePlugin(async () => {
      throw failure;
    });
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
  });

  it("leaves patch rows untouched when patches are omitted", async () => {
    const { client, owner } = await createMemoryFixture();

    await client.updateBundleById(owner.id, { message: "new" });

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      message: "new",
      patches: owner.patches,
    });
  });

  it("clears patch rows when patches are present and empty", async () => {
    const { client, owner } = await createMemoryFixture();

    await client.updateBundleById(owner.id, { patches: [] });

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });

  it("reuses an active aggregate transaction for patch replacement", async () => {
    const { client, owner } = await createMemoryFixture();

    await client.mutate((transaction) =>
      transaction.updateBundleById(owner.id, { patches: [] }),
    );

    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });
});

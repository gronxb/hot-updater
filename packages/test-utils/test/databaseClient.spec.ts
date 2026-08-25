import type { Bundle } from "@hot-updater/core";
import {
  createDatabaseClient,
  DatabaseAtomicCommitUnsupportedError,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "./inMemoryDatabasePlugin";

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  id,
  platform: "ios",
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `storage://${id}`,
  archiveByteSize: 3_000_000_001,
  ...overrides,
});

describe("database client", () => {
  let plugin: DatabasePlugin;

  beforeEach(() => {
    plugin = createInMemoryDatabasePlugin();
  });

  it("inserts and hydrates an aggregate with ordered patch rows", async () => {
    const client = createDatabaseClient(plugin);
    const firstBase = createBundle("001");
    const secondBase = createBundle("002");
    const target = createBundle("003", {
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: firstBase.fileHash,
          patchFileHash: "patch-1",
          patchStorageUri: "storage://patch-1",
          byteSize: 3_000_000_002,
        },
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
          patchFileHash: "patch-2",
          patchStorageUri: "storage://patch-2",
          byteSize: 3_000_000_003,
        },
      ],
    });
    await client.insertBundle(firstBase);
    await client.insertBundle(secondBase);
    await client.insertBundle(target);

    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      patches: target.patches,
    });
  });

  it("paginates filtered bundle aggregates without inferring channels", async () => {
    const client = createDatabaseClient(plugin);
    await client.insertBundle(createBundle("101"));
    await client.insertBundle(createBundle("102", { platform: "android" }));
    await client.insertBundle(createBundle("103"));

    const page = await client.getBundles({
      limit: 1,
      where: { platform: "ios" },
      orderBy: { field: "id", direction: "desc" },
    });
    await client.deleteBundleById("102");

    expect(page.data.map(({ id }) => id)).toEqual(["103"]);
    expect(page.pagination).toMatchObject({ total: 2, hasNextPage: true });
    await expect(client.getChannels()).resolves.toEqual([]);
  });

  it("replaces patches and removes both incoming and outgoing patch rows", async () => {
    const client = createDatabaseClient(plugin);
    const firstBase = createBundle("201");
    const secondBase = createBundle("202");
    const target = createBundle("203", {
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: firstBase.fileHash,
          patchFileHash: "old",
          patchStorageUri: "storage://old",
          byteSize: 3_000_000_002,
        },
      ],
    });
    await client.insertBundle(firstBase);
    await client.insertBundle(secondBase);
    await client.insertBundle(target);

    await client.updateBundleById(target.id, {
      patches: [
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
          patchFileHash: "new",
          patchStorageUri: "storage://new",
          byteSize: 3_000_000_003,
        },
      ],
    });
    await client.deleteBundleById(secondBase.id);

    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      patches: [],
    });
  });

  it("does not let an update retarget bundle or patch ownership", async () => {
    const client = createDatabaseClient(plugin);
    const base = createBundle("211");
    const target = createBundle("212");
    await client.insertBundle(base);
    await client.insertBundle(target);

    await client.updateBundleById(target.id, {
      id: "injected-id",
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "safe-owner",
          patchStorageUri: "storage://safe-owner",
          byteSize: 3_000_000_002,
        },
      ],
    });

    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      id: target.id,
      patches: [expect.objectContaining({ patchFileHash: "safe-owner" })],
    });
    await expect(client.getBundleById("injected-id")).resolves.toBeNull();
  });

  it("rolls back a failed aggregate mutation when transactions are available", async () => {
    const invalid = createBundle("302", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });
    const client = createDatabaseClient(plugin);

    const mutation = client.insertBundle(invalid);

    await expect(mutation).rejects.toThrow("reference");
    await expect(client.getBundleById(invalid.id)).resolves.toBeNull();
  });

  it("rejects patch inserts before sequential writes", async () => {
    const invalid = createBundle("303", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });
    const client = createDatabaseClient({
      ...plugin,
      name: plugin.name,
      commit: (input) => {
        if (input.changes.length > 1) {
          throw new DatabaseAtomicCommitUnsupportedError(plugin.name);
        }
        return plugin.commit(input);
      },
    });

    const mutation = client.insertBundle(invalid);

    await expect(mutation).rejects.toMatchObject({
      name: "DatabasePatchInsertUnsupportedError",
      bundleId: invalid.id,
    });
    await expect(client.getBundleById(invalid.id)).resolves.toBeNull();
  });

  it("runs high-level mutations in one plugin transaction", async () => {
    const client = createDatabaseClient(plugin);
    const base = createBundle("501");
    const invalid = createBundle("502", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
          byteSize: 3_000_000_002,
        },
      ],
    });

    const failedBatch = client.mutate(async (mutation) => {
      await mutation.insertBundle(base);
      await mutation.insertBundle(invalid);
    });

    await expect(failedBatch).rejects.toThrow("reference");
    await expect(client.getBundleById(base.id)).resolves.toBeNull();

    await expect(
      client.mutate(async (mutation) => {
        await mutation.insertBundle(base);
        return "committed" as const;
      }),
    ).resolves.toBe("committed");
    await expect(client.getBundleById(base.id)).resolves.toMatchObject({
      id: base.id,
    });
  });
});

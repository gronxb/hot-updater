import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import { createDatabasePlugin } from "./createDatabasePlugin";
import {
  createDatabaseClient,
  DatabasePatchUpdateUnsupportedError,
} from "./databaseClient";
import { bundleToRow } from "./databaseRows";

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
  it("rejects patch replacement before mutating a non-transaction provider", async () => {
    // Given
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

    // When
    const result = createDatabaseClient(plugin).updateBundleById("owner", {
      enabled: false,
      patches: [],
    });

    // Then
    await expect(result).rejects.toMatchObject({
      name: "DatabasePatchUpdateUnsupportedError",
      bundleId: "owner",
      pluginName: "non-transaction",
    } satisfies Partial<DatabasePatchUpdateUnsupportedError>);
    expect(scalarUpdateCount).toBe(0);
    expect(patchDeleteCount).toBe(0);
  });

  it("leaves patch rows untouched when patches are omitted", async () => {
    // Given
    const { client, owner } = await createBlobFixture();

    // When
    await client.updateBundleById(owner.id, { message: "new" });

    // Then
    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      message: "new",
      patches: owner.patches,
    });
  });

  it("clears patch rows when patches are present and empty", async () => {
    // Given
    const { client, owner } = await createBlobFixture();

    // When
    await client.updateBundleById(owner.id, { patches: [] });

    // Then
    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });

  it("reuses an active aggregate transaction for patch replacement", async () => {
    // Given
    const { client, owner } = await createBlobFixture();

    // When
    await client.mutate((transaction) =>
      transaction.updateBundleById(owner.id, { patches: [] }),
    );

    // Then
    await expect(client.getBundleById(owner.id)).resolves.toMatchObject({
      patches: [],
    });
  });
});

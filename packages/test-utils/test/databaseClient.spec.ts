import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "./inMemoryDatabaseAdapter";

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: id,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  ...overrides,
});

describe("database client", () => {
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    adapter = createInMemoryDatabaseAdapter();
  });

  it("inserts and hydrates an aggregate with ordered patch rows", async () => {
    // Given
    const hook = vi.fn(async () => undefined);
    const client = createDatabaseClient({
      ...adapter,
      onDatabaseUpdated: hook,
    });
    const firstBase = createBundle("001");
    const secondBase = createBundle("002");
    const target = createBundle("003", {
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: firstBase.fileHash,
          patchFileHash: "patch-1",
          patchStorageUri: "storage://patch-1",
        },
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
          patchFileHash: "patch-2",
          patchStorageUri: "storage://patch-2",
        },
      ],
    });
    await client.insertBundle(firstBase);
    await client.insertBundle(secondBase);
    hook.mockClear();

    // When
    await client.insertBundle(target);

    // Then
    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      patches: target.patches,
      patchBaseBundleId: firstBase.id,
    });
    expect(hook).toHaveBeenCalledOnce();
  });

  it("paginates filtered bundle aggregates and lists derived channels", async () => {
    // Given
    const client = createDatabaseClient(adapter);
    await client.insertBundle(createBundle("101"));
    await client.insertBundle(createBundle("102", { channel: "staging" }));
    await client.insertBundle(createBundle("103"));

    // When
    const page = await client.getBundles({
      limit: 1,
      where: { channel: "production" },
      orderBy: { field: "id", direction: "desc" },
    });
    await client.deleteBundleById("102");

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["103"]);
    expect(page.pagination).toMatchObject({ total: 2, hasNextPage: true });
    await expect(client.getChannels()).resolves.toEqual(["production"]);
  });

  it("replaces patches and removes both incoming and outgoing patch rows", async () => {
    // Given
    const client = createDatabaseClient(adapter);
    const firstBase = createBundle("201");
    const secondBase = createBundle("202");
    const target = createBundle("203", {
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: firstBase.fileHash,
          patchFileHash: "old",
          patchStorageUri: "storage://old",
        },
      ],
    });
    await client.insertBundle(firstBase);
    await client.insertBundle(secondBase);
    await client.insertBundle(target);

    // When
    await client.updateBundleById(target.id, {
      channel: "beta",
      patches: [
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
          patchFileHash: "new",
          patchStorageUri: "storage://new",
        },
      ],
    });
    await client.deleteBundleById(secondBase.id);

    // Then
    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      channel: "beta",
      patches: [],
    });
  });

  it("does not let an update retarget bundle or patch ownership", async () => {
    // Given
    const client = createDatabaseClient(adapter);
    const base = createBundle("211");
    const target = createBundle("212");
    await client.insertBundle(base);
    await client.insertBundle(target);

    // When
    await client.updateBundleById(target.id, {
      id: "injected-id",
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "safe-owner",
          patchStorageUri: "storage://safe-owner",
        },
      ],
    });

    // Then
    await expect(client.getBundleById(target.id)).resolves.toMatchObject({
      id: target.id,
      patches: [expect.objectContaining({ patchFileHash: "safe-owner" })],
    });
    await expect(client.getBundleById("injected-id")).resolves.toBeNull();
  });

  it("rolls back a failed aggregate mutation when transactions are available", async () => {
    // Given
    const hook = vi.fn(async () => undefined);
    const invalid = createBundle("302", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    });
    const client = createDatabaseClient({
      ...adapter,
      onDatabaseUpdated: hook,
    });

    // When
    const mutation = client.insertBundle(invalid);

    // Then
    await expect(mutation).rejects.toThrow("reference");
    await expect(client.getBundleById(invalid.id)).resolves.toBeNull();
    expect(hook).not.toHaveBeenCalled();
  });

  it("retains partial state without firing the hook after a sequential failure", async () => {
    // Given
    const hook = vi.fn(async () => undefined);
    const invalid = createBundle("303", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    });
    const { transaction: ignoredTransaction, ...sequentialAdapter } = adapter;
    void ignoredTransaction;
    const client = createDatabaseClient({
      ...sequentialAdapter,
      name: adapter.name,
      onDatabaseUpdated: hook,
    });

    // When
    const mutation = client.insertBundle(invalid);

    // Then
    await expect(mutation).rejects.toThrow("reference");
    await expect(client.getBundleById(invalid.id)).resolves.toMatchObject({
      id: invalid.id,
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("binds request context to every sequential low operation", async () => {
    // Given
    type TestContext = { readonly requestId: string };
    const context = { requestId: "request-1" } satisfies TestContext;
    const seenContexts: (TestContext | undefined)[] = [];
    const { transaction: ignoredTransaction, ...sequentialAdapter } = adapter;
    void ignoredTransaction;
    const contextualAdapter: DatabaseAdapter<TestContext> = {
      ...sequentialAdapter,
      name: adapter.name,
      create: (input, operationContext) => {
        seenContexts.push(operationContext);
        return adapter.create(input);
      },
      findOne: (input, operationContext) => {
        seenContexts.push(operationContext);
        return adapter.findOne(input);
      },
    };
    const client = createDatabaseClient(contextualAdapter);

    // When
    await client.insertBundle(createBundle("304"), context);

    // Then
    expect(seenContexts.length).toBeGreaterThan(0);
    expect(seenContexts.every((seen) => seen === context)).toBe(true);
  });

  it("delegates the update-info fast path and matches the generic path", async () => {
    // Given
    const bundle = createBundle("401");
    const genericClient = createDatabaseClient(adapter);
    await genericClient.insertBundle(bundle);
    const args = {
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: NIL_UUID,
      platform: "ios",
    } as const;
    const expected = await genericClient.getUpdateInfo(args);
    const fastPath = vi.fn(async () => expected);
    const fastClient = createDatabaseClient({
      ...adapter,
      getUpdateInfo: fastPath,
    });

    // When
    const actual = await fastClient.getUpdateInfo(args);

    // Then
    expect(actual).toEqual(expected);
    expect(fastPath).toHaveBeenCalledWith(args);
  });

  it("runs high-level mutations in one adapter transaction", async () => {
    // Given
    const hook = vi.fn(async () => undefined);
    const client = createDatabaseClient({
      ...adapter,
      onDatabaseUpdated: hook,
    });
    const base = createBundle("501");
    const invalid = createBundle("502", {
      patches: [
        {
          baseBundleId: "missing",
          baseFileHash: "missing",
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    });

    // When
    const failedBatch = client.mutate(async (mutation) => {
      await mutation.insertBundle(base);
      await mutation.insertBundle(invalid);
    });

    // Then
    await expect(failedBatch).rejects.toThrow("reference");
    await expect(client.getBundleById(base.id)).resolves.toBeNull();
    expect(hook).not.toHaveBeenCalled();

    await expect(
      client.mutate(async (mutation) => {
        await mutation.insertBundle(base);
        return "committed" as const;
      }),
    ).resolves.toBe("committed");
    await expect(client.getBundleById(base.id)).resolves.toMatchObject({
      id: base.id,
    });
    expect(hook).toHaveBeenCalledOnce();
  });
});

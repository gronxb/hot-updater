import type { UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createDatabaseAdapterCore } from "./databaseAdapterCore";
import {
  currentBundle,
  manifests,
  resolveFileUrl,
  seedBundles,
  targetBundle,
  type TestContext,
  updateArgs,
} from "./databaseAdapterCore.testFixtures";

describe("createDatabaseAdapterCore", () => {
  it("uses the optional low-adapter update fast-path", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(baseAdapter, "findMany");
    const expected: UpdateInfo = {
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    };
    const getUpdateInfo = vi.fn<
      NonNullable<DatabaseAdapter<TestContext>["getUpdateInfo"]>
    >(async () => expected);
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo,
    };
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    // When
    const result = await core.api.getUpdateInfo(updateArgs, context);

    // Then
    expect(result).toEqual(expected);
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs, context);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not scan when the optional update fast-path returns null", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(baseAdapter, "findMany");
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo: vi.fn(async () => null),
    };
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = await core.api.getUpdateInfo(updateArgs);

    // Then
    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives update info through the fixed low models without a fast-path", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = await core.api.getUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    });
  });

  it("resolves manifest assets and patch metadata from v2 rows", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async (storageUri) => manifests.get(storageUri) ?? null,
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs, context);

    // Then
    expect(result).toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "target-bundle-hash",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: currentBundle.id,
            baseFileHash: "current-bundle-hash",
            patchFileHash: "patch-hash",
            patchUrl: "https://assets.example.com/bucket/target/patch.bsdiff",
          },
        },
      },
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(result?.changedAssets).not.toHaveProperty("shared.png");
  });

  it("falls back to archive metadata when a manifest cannot be loaded", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async () => null,
    });

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: "https://assets.example.com/bucket/target/archive.zip",
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("runs the schema readiness guard before a low adapter operation", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    const beforeOperation = vi.fn(async () => {});
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      beforeOperation,
    });

    // When
    await core.api.getChannels();

    // Then
    expect(beforeOperation).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before invoking low create", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    const create = vi.spyOn(adapter, "create");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = core.api.insertBundle({
      ...currentBundle,
      targetAppVersion: null,
      fingerprintHash: null,
    });

    // Then
    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid updates before invoking low update", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await createDatabaseClient(adapter).insertBundle(currentBundle);
    const update = vi.spyOn(adapter, "update");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = core.api.updateBundleById(currentBundle.id, {
      id: "00000000-0000-0000-0000-000000000099",
      targetAppVersion: null,
      fingerprintHash: null,
    });

    // Then
    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves initialization rollbacks without reading manifests", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo: async () => ({
        fileHash: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: null,
      }),
    };
    const readStorageText = vi.fn(async () => null);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText,
    });

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: null,
      fileUrl: null,
      id: NIL_UUID,
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
    expect(readStorageText).not.toHaveBeenCalled();
  });
});

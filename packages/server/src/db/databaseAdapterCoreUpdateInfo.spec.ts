import type { UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core";
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

describe("createDatabaseAdapterCore update info", () => {
  it("uses the optional low-adapter update fast-path", async () => {
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

    const result = await core.api.getUpdateInfo(updateArgs, context);

    expect(result).toEqual(expected);
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs, context);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not scan when the optional update fast-path returns null", async () => {
    const baseAdapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(baseAdapter, "findMany");
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo: vi.fn(async () => null),
    };
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    const result = await core.api.getUpdateInfo(updateArgs);

    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives update info through the fixed low models without a fast-path", async () => {
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    const result = await core.api.getUpdateInfo(updateArgs);

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
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async (storageUri) => manifests.get(storageUri) ?? null,
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    const result = await core.api.getAppUpdateInfo(updateArgs, context);

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
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async () => null,
    });

    const result = await core.api.getAppUpdateInfo(updateArgs);

    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: "https://assets.example.com/bucket/target/archive.zip",
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("resolves initialization rollbacks without reading manifests", async () => {
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

    const result = await core.api.getAppUpdateInfo(updateArgs);

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

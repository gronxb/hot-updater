import type { UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createPluginDatabaseCore } from "./pluginCore";
import {
  currentBundle,
  manifests,
  resolveFileUrl,
  seedBundles,
  targetBundle,
  type TestContext,
  updateArgs,
} from "./pluginCore.testFixtures";

describe("createPluginDatabaseCore", () => {
  it("uses the optional low-adapter update fast-path", async () => {
    // Given
    const adapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(adapter, "findMany");
    const expected: UpdateInfo = {
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    };
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => expected);
    const plugin: DatabasePlugin<TestContext> = {
      ...adapter,
      getUpdateInfo,
    };
    const core = createPluginDatabaseCore(plugin, resolveFileUrl);
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
    const adapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(adapter, "findMany");
    const plugin: DatabasePlugin<TestContext> = {
      ...adapter,
      getUpdateInfo: vi.fn(async () => null),
    };
    const core = createPluginDatabaseCore(plugin, resolveFileUrl);

    // When
    const result = await core.api.getUpdateInfo(updateArgs);

    // Then
    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives update info through the fixed low models without a fast-path", async () => {
    // Given
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createPluginDatabaseCore(adapter, resolveFileUrl);

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
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createPluginDatabaseCore(adapter, resolveFileUrl, {
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
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createPluginDatabaseCore(adapter, resolveFileUrl, {
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
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    const beforeOperation = vi.fn(async () => {});
    const core = createPluginDatabaseCore(adapter, resolveFileUrl, {
      beforeOperation,
    });

    // When
    await core.api.getChannels();

    // Then
    expect(beforeOperation).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before invoking low create", async () => {
    // Given
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    const create = vi.spyOn(adapter, "create");
    const core = createPluginDatabaseCore(adapter, resolveFileUrl);

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
    const adapter: DatabasePlugin<TestContext> =
      createInMemoryDatabaseAdapter();
    await createDatabaseClient(adapter).insertBundle(currentBundle);
    const update = vi.spyOn(adapter, "update");
    const core = createPluginDatabaseCore(adapter, resolveFileUrl);

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
    const adapter = createInMemoryDatabaseAdapter();
    const plugin: DatabasePlugin<TestContext> = {
      ...adapter,
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
    const core = createPluginDatabaseCore(plugin, resolveFileUrl, {
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

import type { UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createDatabasePluginCore } from "./databasePluginCore";
import {
  currentBundle,
  manifests,
  resolveFileUrl,
  seedBundles,
  targetBundle,
  type TestContext,
  updateArgs,
} from "./databasePluginCore.testFixtures";

describe("createDatabasePluginCore update info", () => {
  it("uses the optional low-plugin update fast-path", async () => {
    const basePlugin = createInMemoryDatabasePlugin();
    const findMany = vi.spyOn(basePlugin, "findMany");
    const expected: UpdateInfo = {
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    };
    const getUpdateInfo = vi.fn<NonNullable<DatabasePlugin["getUpdateInfo"]>>(
      async () => expected,
    );
    const plugin: DatabasePlugin = {
      ...basePlugin,
      getUpdateInfo,
    };
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    const result = await core.api.getUpdateInfo(updateArgs, context);

    expect(result).toEqual(expected);
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not scan when the optional update fast-path returns null", async () => {
    const basePlugin = createInMemoryDatabasePlugin();
    const findMany = vi.spyOn(basePlugin, "findMany");
    const plugin: DatabasePlugin = {
      ...basePlugin,
      getUpdateInfo: vi.fn(async () => null),
    };
    const core = createDatabasePluginCore(plugin, resolveFileUrl);

    const result = await core.api.getUpdateInfo(updateArgs);

    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives update info through the fixed low models without a fast-path", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    await seedBundles(plugin);
    const core = createDatabasePluginCore(plugin, resolveFileUrl);

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
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    await seedBundles(plugin);
    const core = createDatabasePluginCore(plugin, resolveFileUrl, {
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
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    await seedBundles(plugin);
    const core = createDatabasePluginCore(plugin, resolveFileUrl, {
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
    const basePlugin = createInMemoryDatabasePlugin();
    const plugin: DatabasePlugin = {
      ...basePlugin,
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
    const core = createDatabasePluginCore(plugin, resolveFileUrl, {
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

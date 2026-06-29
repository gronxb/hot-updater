import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  DatabasePlugin,
  RequestEnvContext,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createPluginDatabaseCore } from "./pluginCore";

const baseBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  channel: "production",
  enabled: true,
  fileHash: "hash-1",
  fingerprintHash: null,
  gitCommitHash: null,
  message: "bundle",
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: "s3://bucket/bundle.zip",
  targetAppVersion: "1.0.0",
};

const updateArgs: GetBundlesArgs = {
  _updateStrategy: "appVersion",
  appVersion: "1.0.0",
  bundleId: NIL_UUID,
  platform: "ios",
};

type TestContext = RequestEnvContext<{
  assetHost: string;
}>;

describe("createPluginDatabaseCore", () => {
  it("forwards telemetry methods from getter-backed database plugins", async () => {
    const authenticateTelemetryKey = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["authenticateTelemetryKey"]>
    >(async () => true);
    const recordLifecycleEvent = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["recordLifecycleEvent"]>
    >(async () => ({
      accepted: true,
      deduped: false,
    }));
    const getPlugin = createDatabasePlugin<Record<string, never>, TestContext>({
      name: "getter-telemetry-plugin",
      factory: () => ({
        authenticateTelemetryKey,
        async commitBundle() {},
        async getBundleById() {
          return null;
        },
        async getBundles() {
          return {
            data: [],
            pagination: {
              currentPage: 1,
              hasNextPage: false,
              hasPreviousPage: false,
              total: 0,
              totalPages: 0,
            },
          };
        },
        async getChannels() {
          return ["production"];
        },
        recordLifecycleEvent,
      }),
    })({});

    const core = createPluginDatabaseCore(
      getPlugin,
      async () => null,
    );
    const context: TestContext = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };
    const payload = {
      appId: "app-1",
      appVersion: "1.0.0",
      bundleId: baseBundle.id,
      channel: "production",
      eventId: "event-1",
      eventType: "app_ready",
      installId: "install-1",
      platform: "ios",
      status: "ACTIVE",
      telemetryKey: "key-1",
    } as const;

    await expect(
      core.api.authenticateTelemetryKey?.("key-1", context),
    ).resolves.toBe(true);
    await expect(
      core.api.recordLifecycleEvent?.(payload, context),
    ).resolves.toEqual({
      accepted: true,
      deduped: false,
    });

    expect(authenticateTelemetryKey).toHaveBeenCalledWith("key-1", context);
    expect(recordLifecycleEvent).toHaveBeenCalledWith(payload, context);
    expect(core.api.issueTelemetryKey).toBeUndefined();
  });

  it("prefers plugin getUpdateInfo fast-path when provided", async () => {
    const getBundles = vi.fn<DatabasePlugin<TestContext>["getBundles"]>();
    const expected: UpdateInfo = {
      fileHash: baseBundle.fileHash,
      id: baseBundle.id,
      message: baseBundle.message,
      shouldForceUpdate: baseBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: baseBundle.storageUri,
    };
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => expected);

    const plugin: DatabasePlugin<TestContext> = {
      name: "fast-path-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById() {
        return null;
      },
      getBundles,
      getUpdateInfo,
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async () => null,
    );
    const context: TestContext = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    await expect(core.api.getUpdateInfo(updateArgs, context)).resolves.toEqual(
      expected,
    );
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs, context);
    expect(getBundles).not.toHaveBeenCalled();
  });

  it("resolves manifest artifacts through storage text reader", async () => {
    const currentBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000001",
      manifestStorageUri: "r2://bucket/current/manifest.json",
      manifestFileHash: "sig:current-manifest",
      assetBaseStorageUri: "r2://bucket/current/files",
    };
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "r2://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "r2://bucket/target/files",
    };
    const manifests = new Map([
      [
        currentBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: currentBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "old-bundle-hash",
            },
          },
        }),
      ],
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "new-bundle-hash",
            },
          },
        }),
      ],
    ]);
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    }));

    const plugin: DatabasePlugin<TestContext> = {
      name: "manifest-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        if (bundleId === currentBundle.id) return currentBundle;
        if (bundleId === targetBundle.id) return targetBundle;
        return null;
      },
      getUpdateInfo,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );

    await expect(
      core.api.getAppUpdateInfo({
        ...updateArgs,
        bundleId: currentBundle.id,
      }),
    ).resolves.toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "new-bundle-hash",
        },
      },
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
  });

  it("uses request bundle identity map for manifest artifact lookups", async () => {
    const currentBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000001",
      manifestStorageUri: "r2://bucket/current/manifest.json",
      manifestFileHash: "sig:current-manifest",
      assetBaseStorageUri: "r2://bucket/current/files",
    };
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "r2://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "r2://bucket/target/files",
    };
    const manifests = new Map([
      [
        currentBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: currentBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "old-bundle-hash",
            },
            "shared.png": {
              fileHash: "same-image-hash",
            },
          },
        }),
      ],
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "target-bundle-hash",
            },
            "shared.png": {
              fileHash: "same-image-hash",
            },
          },
        }),
      ],
    ]);
    const getBundleById = vi.fn<DatabasePlugin<TestContext>["getBundleById"]>(
      async (bundleId) => {
        if (bundleId === currentBundle.id) return currentBundle;
        if (bundleId === targetBundle.id) return targetBundle;
        return null;
      },
    );
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    }));

    const plugin: DatabasePlugin<TestContext> = {
      name: "identity-map-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      getBundleById,
      getUpdateInfo,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );

    const updateInfo = await core.api.getAppUpdateInfo({
      ...updateArgs,
      bundleId: currentBundle.id,
    });
    expect(updateInfo).not.toBeNull();
    if (!updateInfo) {
      throw new Error("expected app update info");
    }

    expect(updateInfo).toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "target-bundle-hash",
        },
      },
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(updateInfo.changedAssets).not.toHaveProperty("shared.png");
    expect(getUpdateInfo).toHaveBeenCalledOnce();
    expect(getBundleById).toHaveBeenCalledTimes(2);
    expect(getBundleById).toHaveBeenCalledWith(targetBundle.id, undefined);
    expect(getBundleById).toHaveBeenCalledWith(currentBundle.id, undefined);
    expect(Object.keys(updateInfo)).not.toContain("__hotUpdaterBundle");
    expect(Object.keys(updateInfo)).not.toContain("__hotUpdaterCurrentBundle");
    expect(JSON.stringify(updateInfo)).not.toContain("__hotUpdaterBundle");
    expect(JSON.stringify(updateInfo)).not.toContain(
      "__hotUpdaterCurrentBundle",
    );
  });

  it("dedupes manifest artifact bundle lookups without request context", async () => {
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "s3://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "s3://bucket/target/files",
    };
    const manifests = new Map([
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "target-bundle-hash",
            },
          },
        }),
      ],
    ]);
    const getBundleById = vi.fn<DatabasePlugin<TestContext>["getBundleById"]>(
      async (bundleId) => (bundleId === targetBundle.id ? targetBundle : null),
    );
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    }));

    const plugin: DatabasePlugin<TestContext> = {
      name: "undefined-context-identity-map-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      getBundleById,
      getUpdateInfo,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );

    const updateInfo = await core.api.getAppUpdateInfo({
      ...updateArgs,
      bundleId: targetBundle.id,
    });

    expect(updateInfo).toMatchObject({
      changedAssets: {},
      id: targetBundle.id,
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(getBundleById).toHaveBeenCalledOnce();
    expect(getBundleById).toHaveBeenCalledWith(targetBundle.id, undefined);
  });

  it("seeds request bundle identity map from provider update lookups", async () => {
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "s3://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "s3://bucket/target/files",
    };
    const manifests = new Map([
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "target-bundle-hash",
            },
          },
        }),
      ],
    ]);
    const getBundleById = vi.fn<DatabasePlugin<TestContext>["getBundleById"]>(
      async () => {
        throw new Error("unexpected provider bundle reread");
      },
    );
    const getUpdateInfo: NonNullable<
      DatabasePlugin<TestContext>["getUpdateInfo"]
    > = async (args, context) =>
      resolveUpdateInfoFromBundles({
        args,
        bundles: [targetBundle],
        context,
      });
    const plugin: DatabasePlugin<TestContext> = {
      name: "seeded-fast-path-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      getBundleById,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      getUpdateInfo,
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );
    const context: TestContext = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const updateInfo = await core.api.getAppUpdateInfo(updateArgs, context);

    expect(updateInfo).toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "target-bundle-hash",
        },
      },
      id: targetBundle.id,
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(getBundleById).not.toHaveBeenCalled();
  });

  it("does not reread providers for current bundles outside direct update lookup results", async () => {
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000003",
      fileHash: "hash-3",
      manifestStorageUri: "s3://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "s3://bucket/target/files",
    };
    const manifests = new Map([
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "target-bundle-hash",
            },
            "image.png": {
              fileHash: "target-image-hash",
            },
          },
        }),
      ],
    ]);
    const getBundleById = vi.fn<DatabasePlugin<TestContext>["getBundleById"]>(
      async () => {
        throw new Error("unexpected provider current bundle reread");
      },
    );
    const getUpdateInfo: NonNullable<
      DatabasePlugin<TestContext>["getUpdateInfo"]
    > = async (args, context) =>
      resolveUpdateInfoFromBundles({
        args,
        bundles: [targetBundle],
        context,
      });
    const plugin: DatabasePlugin<TestContext> = {
      name: "seeded-current-miss-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      getBundleById,
      async getBundles() {
        throw new Error("unexpected provider scan");
      },
      getUpdateInfo,
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );
    const context: TestContext = {
      env: {
        assetHost: "https://assets.example.com",
      },
      request: new Request("https://updates.example.com"),
    };

    const updateInfo = await core.api.getAppUpdateInfo(
      {
        ...updateArgs,
        bundleId: "00000000-0000-0000-0000-0000000000aa",
      },
      context,
    );

    expect(updateInfo).toMatchObject({
      changedAssets: {
        "image.png": {
          file: {
            url: "https://assets.example.com/bucket/target/files/image.png",
          },
          fileHash: "target-image-hash",
        },
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "target-bundle-hash",
        },
      },
      id: targetBundle.id,
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(getBundleById).not.toHaveBeenCalled();
  });

  it("resolves manifest changed assets from deterministic content-addressed storage", async () => {
    const currentBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000001",
      manifestStorageUri: "r2://bucket/current/manifest.json",
      manifestFileHash: "sig:current-manifest",
      assetBaseStorageUri: "r2://bucket/assets",
    };
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "r2://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "r2://bucket/assets",
    };
    const manifests = new Map([
      [
        currentBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: currentBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "old-bundle-hash",
            },
          },
        }),
      ],
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "new-bundle-hash",
            },
          },
        }),
      ],
    ]);
    const plugin: DatabasePlugin<TestContext> = {
      name: "content-addressed-manifest-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        if (bundleId === currentBundle.id) return currentBundle;
        if (bundleId === targetBundle.id) return targetBundle;
        return null;
      },
      async getUpdateInfo() {
        return {
          fileHash: targetBundle.fileHash,
          id: targetBundle.id,
          message: targetBundle.message,
          shouldForceUpdate: targetBundle.shouldForceUpdate,
          status: "UPDATE",
          storageUri: targetBundle.storageUri,
        };
      },
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );

    await expect(
      core.api.getAppUpdateInfo({
        ...updateArgs,
        bundleId: currentBundle.id,
      }),
    ).resolves.toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/assets/sha256/ne/new-bundle-hash.br",
          },
          fileHash: "new-bundle-hash",
        },
      },
    });
  });

  it("falls back to archive metadata when manifest changed assets cannot be resolved", async () => {
    const currentBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000001",
      manifestStorageUri: "r2://bucket/current/manifest.json",
      manifestFileHash: "sig:current-manifest",
      assetBaseStorageUri: "r2://bucket/current/files",
    };
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "r2://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "r2://bucket/target/files",
    };
    const manifests = new Map([
      [
        currentBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: currentBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "old-bundle-hash",
            },
          },
        }),
      ],
      [
        targetBundle.manifestStorageUri,
        JSON.stringify({
          bundleId: targetBundle.id,
          assets: {
            "index.ios.bundle": {
              fileHash: "new-bundle-hash",
            },
          },
        }),
      ],
    ]);
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    }));

    const plugin: DatabasePlugin<TestContext> = {
      name: "manifest-unresolved-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        if (bundleId === currentBundle.id) return currentBundle;
        if (bundleId === targetBundle.id) return targetBundle;
        return null;
      },
      getUpdateInfo,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        if (url.pathname.endsWith("/files/index.ios.bundle.br")) {
          return null;
        }
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async (storageUri) =>
          manifests.get(storageUri) ?? null,
      },
    );

    const updateInfo = await core.api.getAppUpdateInfo({
      ...updateArgs,
      bundleId: currentBundle.id,
    });

    expect(updateInfo).toMatchObject({
      fileHash: "hash-2",
      fileUrl: "https://assets.example.com/bucket/bundle.zip",
      id: targetBundle.id,
      status: "UPDATE",
    });
    expect(updateInfo).not.toHaveProperty("changedAssets");
    expect(updateInfo).not.toHaveProperty("manifestFileHash");
    expect(updateInfo).not.toHaveProperty("manifestUrl");
  });

  it("propagates manifest storage read failures", async () => {
    const targetBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      fileHash: "hash-2",
      manifestStorageUri: "r2://bucket/target/manifest.json",
      manifestFileHash: "sig:target-manifest",
      assetBaseStorageUri: "r2://bucket/target/files",
    };
    const storageError = new Error("storage read failed");
    const getUpdateInfo = vi.fn<
      NonNullable<DatabasePlugin<TestContext>["getUpdateInfo"]>
    >(async () => ({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    }));

    const plugin: DatabasePlugin<TestContext> = {
      name: "manifest-error-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        return bundleId === targetBundle.id ? targetBundle : null;
      },
      getUpdateInfo,
      async getBundles() {
        return {
          data: [targetBundle],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 1,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async (storageUri) => {
        if (!storageUri) return null;
        const url = new URL(storageUri);
        return `https://assets.example.com/${url.host}${url.pathname}`;
      },
      {
        readStorageText: async () => {
          throw storageError;
        },
      },
    );

    await expect(core.api.getAppUpdateInfo(updateArgs)).rejects.toThrow(
      "storage read failed",
    );
  });

  it("does not fall back to scanning when plugin getUpdateInfo returns null", async () => {
    const getBundles = vi.fn<DatabasePlugin["getBundles"]>(async () => ({
      data: [baseBundle],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    }));
    const getUpdateInfo = vi.fn<NonNullable<DatabasePlugin["getUpdateInfo"]>>(
      async () => null,
    );

    const plugin: DatabasePlugin = {
      name: "null-fast-path-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById() {
        return null;
      },
      getBundles,
      getUpdateInfo,
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async () => null,
    );

    await expect(core.api.getUpdateInfo(updateArgs)).resolves.toBeNull();
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs);
    expect(getBundles).not.toHaveBeenCalled();
  });

  it("falls back to scanning when plugin getUpdateInfo is absent", async () => {
    const latestBundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
    };
    const getBundles = vi.fn<DatabasePlugin["getBundles"]>(async () => ({
      data: [latestBundle],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 1,
        totalPages: 1,
      },
    }));

    const plugin: DatabasePlugin = {
      name: "scan-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById() {
        return null;
      },
      getBundles,
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async () => null,
    );

    await expect(core.api.getUpdateInfo(updateArgs)).resolves.toEqual({
      fileHash: latestBundle.fileHash,
      id: latestBundle.id,
      message: latestBundle.message,
      shouldForceUpdate: latestBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: latestBundle.storageUri,
    });
    expect(getBundles).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before appendBundle is called", async () => {
    const appendBundle = vi.fn<DatabasePlugin["appendBundle"]>();
    const commitBundle = vi.fn<DatabasePlugin["commitBundle"]>();

    const plugin: DatabasePlugin = {
      name: "validation-plugin",
      appendBundle,
      commitBundle,
      async deleteBundle() {},
      async getBundleById() {
        return null;
      },
      async getBundles() {
        return {
          data: [],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 0,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      async updateBundle() {},
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async () => null,
    );

    await expect(
      core.api.insertBundle({
        ...baseBundle,
        targetAppVersion: null,
        fingerprintHash: null,
      }),
    ).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(appendBundle).not.toHaveBeenCalled();
    expect(commitBundle).not.toHaveBeenCalled();
  });

  it("rejects invalid updates before plugin.updateBundle is called", async () => {
    const updateBundle = vi.fn<DatabasePlugin["updateBundle"]>();

    const plugin: DatabasePlugin = {
      name: "update-validation-plugin",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(bundleId) {
        return bundleId === baseBundle.id ? baseBundle : null;
      },
      async getBundles() {
        return {
          data: [],
          pagination: {
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
            total: 0,
            totalPages: 1,
          },
        };
      },
      async getChannels() {
        return ["production"];
      },
      updateBundle,
    };

    const core = createPluginDatabaseCore(
      () => plugin,
      async () => null,
    );

    await expect(
      core.api.updateBundleById(baseBundle.id, {
        targetAppVersion: null,
        fingerprintHash: null,
      }),
    ).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(updateBundle).not.toHaveBeenCalled();
  });
});

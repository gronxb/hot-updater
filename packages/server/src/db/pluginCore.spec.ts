import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  DatabasePlugin,
  HotUpdaterContext,
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

type TestContext = HotUpdaterContext<{
  assetHost: string;
}>;

describe("createPluginDatabaseCore", () => {
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
});

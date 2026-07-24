import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { vi } from "vitest";

import { createHandler, type HandlerAPI } from "./handler";

export const NEXT_SDK_VERSION_FOR_TEST = "0.31.0";
export const CURRENT_PACKAGE_SDK_VERSION = "0.30.10";

type TestEnv = {
  tenantId: string;
};

export type TestContext = {
  env: TestEnv;
};

export const testBundle: Bundle = {
  id: "bundle-1",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle-1.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

export const createApi = () =>
  ({
    getAppUpdateInfo: vi
      .fn<HandlerAPI<TestContext>["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI<TestContext>["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI<TestContext>["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI<TestContext>["getChannels"]>()
      .mockResolvedValue(["production"]),
    insertBundle: vi.fn<HandlerAPI<TestContext>["insertBundle"]>(),
    updateBundleById: vi.fn<HandlerAPI<TestContext>["updateBundleById"]>(),
    deleteBundleById: vi.fn<HandlerAPI<TestContext>["deleteBundleById"]>(),
  }) satisfies HandlerAPI<TestContext>;

export const createManagementHandler = (api: HandlerAPI<TestContext>) =>
  createHandler(api, {
    basePath: "/hot-updater",
    coreRoutes: {
      updateCheck: true,
      bundles: { access: { kind: "public" } },
    },
  });

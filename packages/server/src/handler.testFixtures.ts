import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { vi } from "vitest";

import {
  createHandler,
  type HandlerAPI,
  type HandlerFeatures,
} from "./handler";

export const NEXT_SDK_VERSION_FOR_TEST = "0.31.0";
export const CURRENT_PACKAGE_SDK_VERSION = "0.30.10";

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
      .fn<HandlerAPI["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI["getChannels"]>()
      .mockResolvedValue([{ id: "channel-production", name: "production" }]),
    insertChannel: vi.fn<HandlerAPI["insertChannel"]>(),
    deleteChannel: vi.fn<HandlerAPI["deleteChannel"]>(),
    insertBundle: vi.fn<HandlerAPI["insertBundle"]>(),
    updateBundleById: vi.fn<HandlerAPI["updateBundleById"]>(),
    deleteBundleById: vi.fn<HandlerAPI["deleteBundleById"]>(),
  }) satisfies HandlerAPI;

export const createManagementHandler = (
  api: HandlerAPI,
  features: Partial<HandlerFeatures> = {},
) =>
  createHandler(api, {
    basePath: "/hot-updater",
    features: {
      updateCheck: true,
      bundles: true,
      ...features,
    },
  });

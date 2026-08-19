import type { LegacyBundle } from "@hot-updater/core";
import { vi } from "vitest";

import { createHandlers, type HandlerAPI } from "./handler";

export const testBundle: LegacyBundle = {
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

export const createAdminHandler = (api: HandlerAPI) =>
  createHandlers(api).admin;

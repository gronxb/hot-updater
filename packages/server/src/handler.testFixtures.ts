import type { Bundle } from "@hot-updater/core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import { createInProcessCoreApi } from "./core/api";
import { createHotUpdaterHandlers, type HandlerAPI } from "./handler";

export const testBundle: Bundle = {
  id: "bundle-1",
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: "s3://test-bucket/bundles/bundle-1/manifest.json",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "s3://test-bucket/assets",
};

/** Core on an empty in-memory database; spy on a method to stub it. */
export const createApi = (): HandlerAPI => ({
  core: createInProcessCoreApi(createMemoryAdapter()),
});

export const createHandlers = (api: HandlerAPI = createApi()) =>
  createHotUpdaterHandlers({ api });

export const createAdminHandler = (api: HandlerAPI = createApi()) =>
  createHandlers(api).admin;

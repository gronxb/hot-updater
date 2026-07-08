import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { promoteBundle } from "./promoteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
  metadata: {
    app_version: "1.0.0",
  },
  patches: [
    {
      baseBundleId: "0195a408-8f13-7d9b-8df4-000000000000",
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patch.bin",
    },
  ],
  patchBaseBundleId: "0195a408-8f13-7d9b-8df4-000000000000",
  patchBaseFileHash: "base-hash",
  patchFileHash: "patch-hash",
  patchStorageUri: "s3://bucket/patch.bin",
};

function createDatabasePlugin(bundle: Bundle | null = baseBundle) {
  return {
    name: "mockDatabase",
    getChannels: vi.fn(),
    getBundleById: vi.fn(async () => bundle),
    getBundles: vi.fn(),
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    commitBundle: vi.fn(),
    deleteBundle: vi.fn(),
  } satisfies DatabasePlugin;
}

const storagePlugin = {
  name: "mockStorage",
  supportedProtocol: "s3",
} satisfies StoragePlugin;

describe("promoteBundle", () => {
  it("moves a bundle by updating only its channel", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      channel: "staging",
    });

    await expect(
      promoteBundle(
        {
          action: "move",
          bundleId: baseBundle.id,
          targetChannel: "production",
        },
        { databasePlugin, storagePlugin },
      ),
    ).resolves.toEqual({
      ...baseBundle,
      channel: "staging",
    });

    expect(databasePlugin.updateBundle).toHaveBeenCalledWith(baseBundle.id, {
      channel: "production",
    });
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.appendBundle).not.toHaveBeenCalled();
  });

  it("copies a bundle without requiring filesystem storage operations", async () => {
    const databasePlugin = createDatabasePlugin();

    const copiedBundle = await promoteBundle(
      {
        action: "copy",
        bundleId: baseBundle.id,
        nextBundleId: "0195a408-8f13-7d9b-8df4-copy00000000",
        targetChannel: "staging",
      },
      { databasePlugin, storagePlugin },
    );

    expect(copiedBundle).toMatchObject({
      id: "0195a408-8f13-7d9b-8df4-copy00000000",
      channel: "staging",
      storageUri: baseBundle.storageUri,
      patches: [],
      patchBaseBundleId: null,
      patchBaseFileHash: null,
      patchFileHash: null,
      patchStorageUri: null,
    });
    expect(copiedBundle.metadata).toEqual({ app_version: "1.0.0" });
    expect(databasePlugin.appendBundle).toHaveBeenCalledWith(copiedBundle);
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.updateBundle).not.toHaveBeenCalled();
  });
});

// @vitest-environment node

import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteBundle } from "./deleteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "stable",
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

function createStoragePlugin(
  supportedProtocol = "s3",
  overrides?: Partial<StoragePlugin>,
) {
  return {
    name: "mockStorage",
    supportedProtocol,
    upload: vi.fn(),
    delete: vi.fn(),
    getDownloadUrl: vi.fn(),
    ...overrides,
  } satisfies StoragePlugin;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteBundle", () => {
  it("deletes the bundle from database and storage", async () => {
    const databasePlugin = createDatabasePlugin();
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.getBundleById).toHaveBeenCalledWith(baseBundle.id);
    expect(databasePlugin.deleteBundle).toHaveBeenCalledWith(baseBundle);
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);

    expect(
      databasePlugin.deleteBundle.mock.invocationCallOrder[0],
    ).toBeLessThan(databasePlugin.commitBundle.mock.invocationCallOrder[0]);
    expect(
      databasePlugin.commitBundle.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteFromStorage.mock.invocationCallOrder[0]);
  });

  it("skips storage deletion for http urls", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      storageUri: "https://cdn.example.com/bundle.zip",
    });
    const deleteFromStorage = vi.fn();
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });

    await deleteBundle(
      { bundleId: baseBundle.id },
      { databasePlugin, storagePlugin },
    );

    expect(databasePlugin.deleteBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).not.toHaveBeenCalled();
  });

  it("throws before database deletion when the storage protocol is unsupported", async () => {
    const databasePlugin = createDatabasePlugin({
      ...baseBundle,
      storageUri: "r2://bucket/bundle.zip",
    });
    const storagePlugin = createStoragePlugin("s3");

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin },
      ),
    ).rejects.toThrow("No storage plugin for protocol: r2");

    expect(databasePlugin.deleteBundle).not.toHaveBeenCalled();
    expect(databasePlugin.commitBundle).not.toHaveBeenCalled();
    expect(storagePlugin.delete).not.toHaveBeenCalled();
  });

  it("keeps bundle deletion successful when storage cleanup fails", async () => {
    const databasePlugin = createDatabasePlugin();
    const deleteFromStorage = vi.fn(async () => {
      throw new Error("storage delete failed");
    });
    const storagePlugin = createStoragePlugin("s3", {
      delete: deleteFromStorage,
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      deleteBundle(
        { bundleId: baseBundle.id },
        { databasePlugin, storagePlugin },
      ),
    ).resolves.toBeUndefined();

    expect(databasePlugin.deleteBundle).toHaveBeenCalledOnce();
    expect(databasePlugin.commitBundle).toHaveBeenCalledOnce();
    expect(deleteFromStorage).toHaveBeenCalledWith(baseBundle.storageUri);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete bundle from storage:",
      expect.any(Error),
    );
  });
});

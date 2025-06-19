import { describe, it, expect, vi } from "vitest";
import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import type { DatabaseAdapter, StorageAdapter } from "@hot-updater/plugin-core";
import { getUpdateInfo } from "./adapterGetUpdateInfo";

describe("adapterGetUpdateInfo", () => {
  it("should return null when database returns null", async () => {
    const mockDatabase: DatabaseAdapter = {
      name: "mock",
      getUpdateInfo: vi.fn().mockResolvedValue(null),
      getTargetAppVersions: vi.fn()
    };

    const mockStorage: StorageAdapter[] = [];

    const args: GetBundlesArgs = {
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "test-bundle",
      _updateStrategy: "appVersion"
    };

    const result = await getUpdateInfo({
      database: mockDatabase,
      storageAdapters: mockStorage,
      args
    });

    expect(result).toBeNull();
    expect(mockDatabase.getUpdateInfo).toHaveBeenCalledWith(args);
  });

  it("should return update info without signed URL when storageUri is null", async () => {
    const mockUpdateInfo: UpdateInfo = {
      id: "bundle-1",
      shouldForceUpdate: false,
      message: "Test update",
      status: "UPDATE",
      storageUri: null
    };

    const mockDatabase: DatabaseAdapter = {
      name: "mock",
      getUpdateInfo: vi.fn().mockResolvedValue(mockUpdateInfo),
      getTargetAppVersions: vi.fn()
    };

    const mockStorage: StorageAdapter[] = [];

    const args: GetBundlesArgs = {
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "test-bundle",
      _updateStrategy: "appVersion"
    };

    const result = await getUpdateInfo({
      database: mockDatabase,
      storageAdapters: mockStorage,
      args
    });

    expect(result).toEqual(mockUpdateInfo);
  });

  it("should return update info with signed URL when storageUri is provided", async () => {
    const mockUpdateInfo: UpdateInfo = {
      id: "bundle-1",
      shouldForceUpdate: false,
      message: "Test update",
      status: "UPDATE",
      storageUri: "s3://bucket/path/to/bundle.zip"
    };

    const signedUrl = "https://signed-url.com/bundle.zip";

    const mockDatabase: DatabaseAdapter = {
      name: "mock",
      getUpdateInfo: vi.fn().mockResolvedValue(mockUpdateInfo),
      getTargetAppVersions: vi.fn()
    };

    const mockStorage: StorageAdapter[] = [{
      name: "s3",
      supportedSchemas: ["s3"],
      getSignedUrl: vi.fn().mockResolvedValue(signedUrl)
    }];

    const args: GetBundlesArgs = {
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "test-bundle",
      _updateStrategy: "appVersion"
    };

    const result = await getUpdateInfo({
      database: mockDatabase,
      storageAdapters: mockStorage,
      args
    });

    expect(result).toEqual({
      ...mockUpdateInfo,
      storageUri: signedUrl
    });

    expect(mockStorage[0].getSignedUrl).toHaveBeenCalledWith(
      mockUpdateInfo.storageUri,
      3600
    );
  });

  it("should throw error when no compatible storage adapter is found", async () => {
    const mockUpdateInfo: UpdateInfo = {
      id: "bundle-1",
      shouldForceUpdate: false,
      message: "Test update",
      status: "UPDATE",
      storageUri: "s3://bucket/path/to/bundle.zip"
    };

    const mockDatabase: DatabaseAdapter = {
      name: "mock",
      getUpdateInfo: vi.fn().mockResolvedValue(mockUpdateInfo),
      getTargetAppVersions: vi.fn()
    };

    const mockStorage: StorageAdapter[] = [{
      name: "r2",
      supportedSchemas: ["r2"],
      getSignedUrl: vi.fn()
    }];

    const args: GetBundlesArgs = {
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "test-bundle",
      _updateStrategy: "appVersion"
    };

    await expect(getUpdateInfo({
      database: mockDatabase,
      storageAdapters: mockStorage,
      args
    })).rejects.toThrow("No storage adapter found for schema: s3");
  });

  it("should use custom expiresIn value", async () => {
    const mockUpdateInfo: UpdateInfo = {
      id: "bundle-1",
      shouldForceUpdate: false,
      message: "Test update",
      status: "UPDATE",
      storageUri: "s3://bucket/path/to/bundle.zip"
    };

    const signedUrl = "https://signed-url.com/bundle.zip";
    const customExpiresIn = 7200; // 2 hours

    const mockDatabase: DatabaseAdapter = {
      name: "mock",
      getUpdateInfo: vi.fn().mockResolvedValue(mockUpdateInfo),
      getTargetAppVersions: vi.fn()
    };

    const mockStorage: StorageAdapter[] = [{
      name: "s3",
      supportedSchemas: ["s3"],
      getSignedUrl: vi.fn().mockResolvedValue(signedUrl)
    }];

    const args: GetBundlesArgs = {
      platform: "ios",
      appVersion: "1.0.0",
      bundleId: "test-bundle",
      _updateStrategy: "appVersion"
    };

    await getUpdateInfo({
      database: mockDatabase,
      storageAdapters: mockStorage,
      args,
      expiresIn: customExpiresIn
    });

    expect(mockStorage[0].getSignedUrl).toHaveBeenCalledWith(
      mockUpdateInfo.storageUri,
      customExpiresIn
    );
  });
});
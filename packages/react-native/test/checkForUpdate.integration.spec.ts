import type { AppUpdateInfo } from "@hot-updater/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "../src/checkForUpdate";
import * as native from "../src/native";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("../src/native", () => ({
  getAppVersion: vi.fn(),
  getBundleId: vi.fn(),
  getChannel: vi.fn(),
  getCurrentBundleHash: vi.fn(),
  getFingerprintHash: vi.fn(),
  getMinBundleId: vi.fn(),
  updateBundle: vi.fn(),
}));

describe("checkForUpdate OTA v2 integration", () => {
  const mockedNative = vi.mocked(native);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__DEV__", false);

    mockedNative.getAppVersion.mockReturnValue("1.0.0");
    mockedNative.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000002",
    );
    mockedNative.getMinBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000001",
    );
    mockedNative.getChannel.mockReturnValue("production");
    mockedNative.getFingerprintHash.mockReturnValue(null);
    mockedNative.getCurrentBundleHash.mockReturnValue(null);
    mockedNative.updateBundle.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends empty currentHash when native hash is unavailable", async () => {
    const checkUpdate = vi.fn().mockResolvedValue(null);

    await checkForUpdate({
      updateStrategy: "appVersion",
      resolver: {
        checkUpdate,
      },
    });

    expect(checkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentHash: "",
      }),
    );
  });

  it("passes serialized incremental plan to native updateBundle", async () => {
    const updateInfo: AppUpdateInfo = {
      id: "00000000-0000-0000-0000-000000000100",
      shouldForceUpdate: false,
      message: "incremental update",
      status: "UPDATE",
      fileHash: "target-bundle-hash",
      fileUrl: null,
      incremental: {
        protocol: "bsdiff-v1",
        baseBundleId: "00000000-0000-0000-0000-000000000002",
        baseBundleHash: "base-hash",
        bundlePath: "index.ios.bundle",
        patch: {
          fileUrl: "https://cdn.example.com/patch.bin",
          fileHash: "patch-hash",
          size: 123,
        },
        manifest: [
          {
            path: "index.ios.bundle",
            hash: "target-bundle-hash",
            size: 456,
            kind: "bundle",
          },
        ],
        changedAssets: [],
      },
    };

    const result = await checkForUpdate({
      updateStrategy: "appVersion",
      resolver: {
        checkUpdate: vi.fn().mockResolvedValue(updateInfo),
      },
    });

    expect(result).not.toBeNull();
    await result?.updateBundle();

    expect(mockedNative.updateBundle).toHaveBeenCalledWith({
      bundleId: updateInfo.id,
      fileUrl: updateInfo.fileUrl,
      fileHash: updateInfo.fileHash,
      updatePlanJson: JSON.stringify(updateInfo.incremental),
      status: updateInfo.status,
    });
  });

  it("uses null updatePlanJson for legacy response", async () => {
    const updateInfo: AppUpdateInfo = {
      id: "00000000-0000-0000-0000-000000000101",
      shouldForceUpdate: false,
      message: null,
      status: "UPDATE",
      fileHash: "legacy-hash",
      fileUrl: "https://cdn.example.com/bundle.zip",
    };

    const result = await checkForUpdate({
      updateStrategy: "appVersion",
      resolver: {
        checkUpdate: vi.fn().mockResolvedValue(updateInfo),
      },
    });

    expect(result).not.toBeNull();
    await result?.updateBundle();

    expect(mockedNative.updateBundle).toHaveBeenCalledWith({
      bundleId: updateInfo.id,
      fileUrl: updateInfo.fileUrl,
      fileHash: updateInfo.fileHash,
      updatePlanJson: null,
      status: updateInfo.status,
    });
  });
});

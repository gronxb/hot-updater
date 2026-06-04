import type { AppUpdateAvailableInfo } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterResolver } from "./types";

const nativeMocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  getAppVersion: vi.fn(() => "1.0"),
  getBundleId: vi.fn(() => "current-bundle"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "123"),
  getDefaultChannel: vi.fn(() => "production"),
  getFingerprintHash: vi.fn(() => null),
  getMinBundleId: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
  isChannelSwitched: vi.fn(() => false),
  resetChannel: vi.fn(),
  updateBundle: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

vi.mock("./native", () => nativeMocks);

const createBuiltinRollbackInfo = (): AppUpdateAvailableInfo => ({
  changedAssets: null,
  fileHash: null,
  fileUrl: null,
  id: "00000000-0000-0000-0000-000000000000",
  manifestFileHash: null,
  manifestUrl: null,
  shouldForceUpdate: true,
  status: "ROLLBACK",
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("__DEV__", false);

    nativeMocks.addListener.mockReset();
    nativeMocks.addListener.mockReturnValue(() => {});
    nativeMocks.getAppVersion.mockReset();
    nativeMocks.getAppVersion.mockReturnValue("1.0");
    nativeMocks.getBundleId.mockReset();
    nativeMocks.getBundleId.mockReturnValue("current-bundle");
    nativeMocks.getChannel.mockReset();
    nativeMocks.getChannel.mockReturnValue("production");
    nativeMocks.getCohort.mockReset();
    nativeMocks.getCohort.mockReturnValue("123");
    nativeMocks.getDefaultChannel.mockReset();
    nativeMocks.getDefaultChannel.mockReturnValue("production");
    nativeMocks.getFingerprintHash.mockReset();
    nativeMocks.getFingerprintHash.mockReturnValue(null);
    nativeMocks.getMinBundleId.mockReset();
    nativeMocks.getMinBundleId.mockReturnValue(
      "00000000-0000-7000-8000-000000000000",
    );
    nativeMocks.isChannelSwitched.mockReset();
    nativeMocks.isChannelSwitched.mockReturnValue(false);
    nativeMocks.resetChannel.mockReset();
    nativeMocks.resetChannel.mockResolvedValue(true);
    nativeMocks.updateBundle.mockReset();
    nativeMocks.updateBundle.mockResolvedValue(true);
  });

  it("resets native state for built-in rollback on the default channel", async () => {
    const resolver: HotUpdaterResolver = {
      checkUpdate: vi.fn(async () => createBuiltinRollbackInfo()),
    };
    const { checkForUpdate } = await import("./checkForUpdate");

    const updateInfo = await checkForUpdate({ resolver });

    await expect(updateInfo?.updateBundle()).resolves.toBe(true);
    expect(nativeMocks.resetChannel).toHaveBeenCalledTimes(1);
    expect(nativeMocks.updateBundle).not.toHaveBeenCalled();
  });
});

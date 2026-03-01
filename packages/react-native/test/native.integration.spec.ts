import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentBundleHash,
  updateBundle as updateBundleNative,
} from "../src/native";
import HotUpdaterNative from "../src/specs/NativeHotUpdater";

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
}));

vi.mock("../src/specs/NativeHotUpdater", () => ({
  __esModule: true,
  default: {
    updateBundle: vi.fn(),
    getConstants: vi.fn(() => ({
      MIN_BUNDLE_ID: "00000000-0000-0000-0000-000000000000",
      APP_VERSION: "1.0.0",
      CHANNEL: "production",
      FINGERPRINT_HASH: null,
    })),
    reload: vi.fn(),
    notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
    getCrashHistory: vi.fn(() => []),
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn(() => ""),
    getCurrentBundleHash: vi.fn(),
  },
}));

describe("native OTA v2 integration", () => {
  const mockedHotUpdaterNative = vi.mocked(HotUpdaterNative);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedHotUpdaterNative.updateBundle.mockResolvedValue(true);
    mockedHotUpdaterNative.getCurrentBundleHash.mockReturnValue("sha256-current");
  });

  it("forwards updatePlanJson when params object is used", async () => {
    await updateBundleNative({
      bundleId: "00000000-0000-0000-0000-000000000100",
      fileUrl: "https://cdn.example.com/bundle",
      fileHash: "target-hash",
      updatePlanJson: '{"protocol":"bsdiff-v1"}',
      status: "UPDATE",
    });

    expect(mockedHotUpdaterNative.updateBundle).toHaveBeenCalledWith({
      bundleId: "00000000-0000-0000-0000-000000000100",
      fileUrl: "https://cdn.example.com/bundle",
      fileHash: "target-hash",
      updatePlanJson: '{"protocol":"bsdiff-v1"}',
    });
  });

  it("keeps updatePlanJson null for deprecated overload", async () => {
    await updateBundleNative(
      "00000000-0000-0000-0000-000000000101",
      "https://cdn.example.com/legacy",
    );

    expect(mockedHotUpdaterNative.updateBundle).toHaveBeenCalledWith({
      bundleId: "00000000-0000-0000-0000-000000000101",
      fileUrl: "https://cdn.example.com/legacy",
      fileHash: null,
      updatePlanJson: null,
    });
  });

  it("returns current bundle hash from native module", () => {
    expect(getCurrentBundleHash()).toBe("sha256-current");
    expect(mockedHotUpdaterNative.getCurrentBundleHash).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let nativeModule: typeof import("../src/native");
  let hotUpdaterNative: typeof import("../src/specs/NativeHotUpdater").default;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "__HOT_UPDATER_BUNDLE_ID",
      "00000000-0000-0000-0000-000000000000",
    );
    vi.resetModules();

    nativeModule = await import("../src/native");
    ({ default: hotUpdaterNative } = await import(
      "../src/specs/NativeHotUpdater"
    ));

    vi.mocked(hotUpdaterNative.updateBundle).mockResolvedValue(true);
    vi.mocked(hotUpdaterNative.getCurrentBundleHash).mockReturnValue(
      "sha256-current",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards updatePlanJson when params object is used", async () => {
    await nativeModule.updateBundle({
      bundleId: "00000000-0000-0000-0000-000000000100",
      fileUrl: "https://cdn.example.com/bundle",
      fileHash: "target-hash",
      updatePlanJson: '{"protocol":"bsdiff-v1"}',
      status: "UPDATE",
    });

    expect(hotUpdaterNative.updateBundle).toHaveBeenCalledWith({
      bundleId: "00000000-0000-0000-0000-000000000100",
      fileUrl: "https://cdn.example.com/bundle",
      fileHash: "target-hash",
      updatePlanJson: '{"protocol":"bsdiff-v1"}',
    });
  });

  it("keeps updatePlanJson null for deprecated overload", async () => {
    await nativeModule.updateBundle(
      "00000000-0000-0000-0000-000000000101",
      "https://cdn.example.com/legacy",
    );

    expect(hotUpdaterNative.updateBundle).toHaveBeenCalledWith({
      bundleId: "00000000-0000-0000-0000-000000000101",
      fileUrl: "https://cdn.example.com/legacy",
      fileHash: null,
      updatePlanJson: null,
    });
  });

  it("returns current bundle hash from native module", () => {
    expect(nativeModule.getCurrentBundleHash()).toBe("sha256-current");
    expect(hotUpdaterNative.getCurrentBundleHash).toHaveBeenCalledTimes(1);
  });
});

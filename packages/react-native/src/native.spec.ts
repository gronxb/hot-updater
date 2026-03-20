import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  vi.stubGlobal("__HOT_UPDATER_BUNDLE_ID", "bundle-id");

  return {
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn(() => null),
    getConstants: vi.fn(() => ({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
    })),
    getCrashHistory: vi.fn(() => []),
    notifyAppReady: vi.fn(),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setBundleURL: vi.fn(),
    switchChannel: vi.fn(),
    updateBundle: vi.fn(),
  };
});

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./specs/NativeHotUpdater", () => ({
  default: nativeModuleMock,
}));

describe("notifyAppReady", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeModuleMock.notifyAppReady.mockReset();
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
    });
  });

  it("normalizes legacy PROMOTED launch reports to STABLE", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue(
      JSON.stringify({ status: "PROMOTED" }),
    );

    const { notifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "STABLE" });
    expect(nativeModuleMock.notifyAppReady).toHaveBeenCalledWith();
  });

  it("returns RECOVERED launch reports unchanged", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      crashedBundleId: "bundle-123",
      status: "RECOVERED",
    });

    const { notifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({
      crashedBundleId: "bundle-123",
      status: "RECOVERED",
    });
  });

  it("falls back to STABLE for malformed old-arch payloads", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue("{");

    const { notifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "STABLE" });
  });
});

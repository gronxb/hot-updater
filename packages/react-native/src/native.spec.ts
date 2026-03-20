import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  const getManifestAssets = vi.fn<() => Record<string, string> | string>();

  return {
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn(() => null),
    getBundleId: vi.fn(() => "bundle-id"),
    getManifestAssets,
    getConstants: vi.fn(() => ({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
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
      MIN_BUNDLE_ID: "min-bundle-id",
    });
    nativeModuleMock.getBundleId.mockReturnValue("bundle-id");
    nativeModuleMock.getManifestAssets.mockReturnValue({
      "index.android.bundle": "hash-123",
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

  it("returns the native bundle id when available", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");

    const { getBundleId } = await import("./native");

    expect(getBundleId()).toBe("bundle-123");
  });

  it("falls back to MIN_BUNDLE_ID when native bundle id is missing", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("");

    const { getBundleId } = await import("./native");

    expect(getBundleId()).toBe("min-bundle-id");
  });

  it("returns manifest assets from native objects", async () => {
    nativeModuleMock.getManifestAssets.mockReturnValue({
      "assets/logo.png": "hash-logo",
      "index.android.bundle": "hash-bundle",
    });

    const { getManifestAssets } = await import("./native");

    expect(getManifestAssets()).toEqual({
      "assets/logo.png": "hash-logo",
      "index.android.bundle": "hash-bundle",
    });
  });

  it("parses manifest assets from old-arch JSON payloads", async () => {
    nativeModuleMock.getManifestAssets.mockReturnValue(
      JSON.stringify({
        "assets/logo.png": "hash-logo",
      }),
    );

    const { getManifestAssets } = await import("./native");

    expect(getManifestAssets()).toEqual({
      "assets/logo.png": "hash-logo",
    });
  });

  it("returns an empty object for malformed manifest assets payloads", async () => {
    nativeModuleMock.getManifestAssets.mockReturnValue("{");

    const { getManifestAssets } = await import("./native");

    expect(getManifestAssets()).toEqual({});
  });
});

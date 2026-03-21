import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  const getManifest = vi.fn<() => Record<string, unknown> | string>();

  return {
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn(() => null),
    getBundleId: vi.fn(() => "bundle-id"),
    getManifest,
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
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "index.android.bundle": {
          fileHash: "hash-123",
        },
      },
      bundleId: "bundle-id",
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

  it("returns manifest from native objects", async () => {
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
        "index.android.bundle": {
          fileHash: "hash-bundle",
        },
      },
      bundleId: "bundle-123",
    });

    const { getManifest } = await import("./native");

    expect(getManifest()).toEqual({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
        "index.android.bundle": {
          fileHash: "hash-bundle",
        },
      },
      bundleId: "bundle-123",
    });
  });

  it("normalizes legacy manifest asset entries from native objects", async () => {
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "assets/logo.png": "hash-logo",
      },
      bundleId: "bundle-123",
    });

    const { getManifest } = await import("./native");

    expect(getManifest()).toEqual({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
      },
      bundleId: "bundle-123",
    });
  });

  it("parses manifest from old-arch JSON payloads", async () => {
    nativeModuleMock.getManifest.mockReturnValue(
      JSON.stringify({
        assets: {
          "assets/logo.png": {
            fileHash: "hash-logo",
          },
        },
        bundleId: "bundle-123",
      }),
    );

    const { getManifest } = await import("./native");

    expect(getManifest()).toEqual({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
      },
      bundleId: "bundle-123",
    });
  });

  it("normalizes legacy manifest asset entries from old-arch JSON payloads", async () => {
    nativeModuleMock.getManifest.mockReturnValue(
      JSON.stringify({
        assets: {
          "assets/logo.png": "hash-logo",
        },
        bundleId: "bundle-123",
      }),
    );

    const { getManifest } = await import("./native");

    expect(getManifest()).toEqual({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
      },
      bundleId: "bundle-123",
    });
  });

  it("returns an empty-assets manifest for malformed payloads", async () => {
    nativeModuleMock.getManifest.mockReturnValue("{");

    const { getManifest } = await import("./native");

    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "bundle-id",
    });
  });
});

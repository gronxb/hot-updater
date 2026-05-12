import { INVALID_COHORT_ERROR_MESSAGE } from "@hot-updater/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  const getManifest = vi.fn<() => Record<string, unknown> | string>();
  const getCrashHistory = vi.fn<() => string[] | string>(() => []);

  return {
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn<() => string | null>(() => null),
    getBundleId: vi.fn<() => string | null>(() => "bundle-id"),
    getCohort: vi.fn<() => string>(() => "123"),
    getManifest,
    getCrashHistory,
    getConstants: vi.fn(() => ({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    })),
    notifyAppReady: vi.fn(),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setCohort: vi.fn(),
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
    nativeModuleMock.getBaseURL.mockReset();
    nativeModuleMock.getBundleId.mockReset();
    nativeModuleMock.getCrashHistory.mockReset();
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    });
    nativeModuleMock.getBundleId.mockReturnValue("bundle-id");
    nativeModuleMock.getBaseURL.mockReturnValue(null);
    nativeModuleMock.getCrashHistory.mockReturnValue([]);
    nativeModuleMock.getCohort.mockReset();
    nativeModuleMock.getCohort.mockReturnValue("123");
    nativeModuleMock.getManifest.mockReset();
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "index.android.bundle": {
          fileHash: "hash-123",
        },
      },
      bundleId: "bundle-id",
    });
    nativeModuleMock.resetChannel.mockReset();
    nativeModuleMock.setCohort.mockReset();
    nativeModuleMock.updateBundle.mockReset();
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

  it("throws when native SDK does not expose getBundleId", async () => {
    const nativeModule = nativeModuleMock as typeof nativeModuleMock & {
      getBundleId?: typeof nativeModuleMock.getBundleId;
    };
    const originalGetBundleId = nativeModule.getBundleId;
    nativeModule.getBundleId = null as unknown as Mock<() => string | null>;

    try {
      const { getBundleId } = await import("./native");

      expect(() => getBundleId()).toThrow(
        "Native module is missing 'getBundleId()'",
      );
    } finally {
      nativeModule.getBundleId = originalGetBundleId;
    }
  });

  it("falls back to MIN_BUNDLE_ID when native reports an empty bundle id", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("");

    const { getBundleId } = await import("./native");

    expect(getBundleId()).toBe("min-bundle-id");
  });

  it("falls back to MIN_BUNDLE_ID when native bundle id is null", async () => {
    nativeModuleMock.getBundleId.mockReturnValue(null);

    const { getBundleId } = await import("./native");

    expect(getBundleId()).toBe("min-bundle-id");
  });

  it("falls back to MIN_BUNDLE_ID for legacy NIL_UUID bundle ids", async () => {
    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000000",
    );

    const { getBundleId } = await import("./native");

    expect(getBundleId()).toBe("min-bundle-id");
  });

  it("returns manifest from native objects", async () => {
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
          signature: "sig-logo",
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
          signature: "sig-logo",
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

  it("caches active bundle getters within a JS runtime", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
      },
      bundleId: "bundle-123",
    });
    nativeModuleMock.getBaseURL.mockReturnValue("file:///bundle-123");

    const { getBaseURL, getBundleId, getManifest } = await import("./native");

    expect(getBundleId()).toBe("bundle-123");
    expect(getBundleId()).toBe("bundle-123");
    expect(nativeModuleMock.getBundleId).toHaveBeenCalledTimes(1);

    const firstManifest = getManifest();
    firstManifest.assets["assets/logo.png"] = {
      fileHash: "mutated-hash",
    };

    expect(getManifest()).toEqual({
      assets: {
        "assets/logo.png": {
          fileHash: "hash-logo",
        },
      },
      bundleId: "bundle-123",
    });
    expect(nativeModuleMock.getManifest).toHaveBeenCalledTimes(1);

    expect(getBaseURL()).toBe("file:///bundle-123");
    expect(getBaseURL()).toBe("file:///bundle-123");
    expect(nativeModuleMock.getBaseURL).toHaveBeenCalledTimes(1);
  });

  it("uses the launched bundle reported by native after updateBundle succeeds", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {},
      bundleId: "bundle-123",
    });
    nativeModuleMock.getBaseURL.mockReturnValue("file:///bundle-123");
    nativeModuleMock.updateBundle.mockResolvedValue(true);

    const { getBaseURL, getBundleId, getManifest, updateBundle } =
      await import("./native");

    expect(getBundleId()).toBe("bundle-123");
    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "bundle-123",
    });
    expect(getBaseURL()).toBe("file:///bundle-123");

    await updateBundle({
      bundleId: "bundle-456",
      fileHash: null,
      fileUrl: "https://example.com/bundle.zip",
      status: "UPDATE",
    });

    expect(getBundleId()).toBe("bundle-123");
    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "bundle-123",
    });
    expect(getBaseURL()).toBe("file:///bundle-123");
    expect(nativeModuleMock.getBundleId).toHaveBeenCalledTimes(2);
    expect(nativeModuleMock.getManifest).toHaveBeenCalledTimes(2);
    expect(nativeModuleMock.getBaseURL).toHaveBeenCalledTimes(2);
  });

  it("forwards manifest artifact parameters to native updateBundle", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.updateBundle.mockResolvedValue(true);

    const { updateBundle } = await import("./native");

    await updateBundle({
      bundleId: "bundle-789",
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://example.com/files/index.ios.bundle.br",
          },
          fileHash: "hash-next",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: "bundle-123",
            baseFileHash: "hash-prev",
            patchFileHash: "hash-patch",
            patchUrl: "https://example.com/files/index.ios.bundle.bsdiff",
          },
        },
      },
      fileHash: "sig:archive",
      fileUrl: "https://example.com/bundle.zip",
      manifestFileHash: "sig:manifest",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE",
    });

    expect(nativeModuleMock.updateBundle).toHaveBeenCalledWith({
      bundleId: "bundle-789",
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://example.com/files/index.ios.bundle.br",
          },
          fileHash: "hash-next",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: "bundle-123",
            baseFileHash: "hash-prev",
            patchFileHash: "hash-patch",
            patchUrl: "https://example.com/files/index.ios.bundle.bsdiff",
          },
        },
      },
      channel: undefined,
      fileHash: "sig:archive",
      fileUrl: "https://example.com/bundle.zip",
      manifestFileHash: "sig:manifest",
      manifestUrl: "https://example.com/manifest.json",
    });
  });

  it("invalidates cached bundle getters after resetChannel succeeds", async () => {
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "beta",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    });
    nativeModuleMock.getBundleId.mockReturnValue("bundle-beta");
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {},
      bundleId: "bundle-beta",
    });
    nativeModuleMock.getBaseURL.mockReturnValue("file:///bundle-beta");
    nativeModuleMock.resetChannel.mockResolvedValue(true);

    const { getBaseURL, getBundleId, getManifest, resetChannel } =
      await import("./native");

    expect(getBundleId()).toBe("bundle-beta");
    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "bundle-beta",
    });
    expect(getBaseURL()).toBe("file:///bundle-beta");

    nativeModuleMock.getBundleId.mockReturnValue(null);
    nativeModuleMock.getManifest.mockReturnValue({});
    nativeModuleMock.getBaseURL.mockReturnValue("");

    await expect(resetChannel()).resolves.toBe(true);

    expect(getBundleId()).toBe("min-bundle-id");
    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "min-bundle-id",
    });
    expect(getBaseURL()).toBeNull();
    expect(nativeModuleMock.getBundleId).toHaveBeenCalledTimes(2);
    expect(nativeModuleMock.getManifest).toHaveBeenCalledTimes(2);
    expect(nativeModuleMock.getBaseURL).toHaveBeenCalledTimes(2);
  });

  it("delegates resetChannel to native even when exported channel constants already match", async () => {
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "beta",
      DEFAULT_CHANNEL: "beta",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    });
    nativeModuleMock.resetChannel.mockResolvedValue(true);

    const { resetChannel } = await import("./native");

    await expect(resetChannel()).resolves.toBe(true);
    expect(nativeModuleMock.resetChannel).toHaveBeenCalledTimes(1);
  });

  it("parses crash history from legacy JSON payloads", async () => {
    nativeModuleMock.getCrashHistory.mockReturnValue(
      JSON.stringify(["bundle-1", "bundle-2"]),
    );

    const { getCrashHistory } = await import("./native");

    expect(getCrashHistory()).toEqual(["bundle-1", "bundle-2"]);
  });

  it("falls back to an empty crash history for malformed payloads", async () => {
    nativeModuleMock.getCrashHistory.mockReturnValue("{");

    const { getCrashHistory } = await import("./native");

    expect(getCrashHistory()).toEqual([]);
  });

  it("passes normalized cohort overrides to native", async () => {
    const { setCohort } = await import("./native");

    setCohort(" QA-Group ");

    expect(nativeModuleMock.setCohort).toHaveBeenCalledWith("qa-group");
  });

  it("returns the most recently set cohort before native reads catch up", async () => {
    nativeModuleMock.getCohort.mockReturnValue("123");

    const { getCohort, setCohort } = await import("./native");

    setCohort(" QA-Group ");

    expect(getCohort()).toBe("qa-group");
    expect(nativeModuleMock.getCohort).not.toHaveBeenCalled();
  });

  it("throws when attempting to clear the cohort with an empty value", async () => {
    const { setCohort } = await import("./native");

    expect(() => setCohort("")).toThrow(INVALID_COHORT_ERROR_MESSAGE);
    expect(nativeModuleMock.setCohort).not.toHaveBeenCalled();
  });

  it("throws for invalid cohort overrides", async () => {
    const { setCohort } = await import("./native");

    expect(() => setCohort("Bad Cohort")).toThrow(INVALID_COHORT_ERROR_MESSAGE);
    expect(nativeModuleMock.setCohort).not.toHaveBeenCalled();
  });

  it("throws for cohort overrides longer than the limit", async () => {
    const { setCohort } = await import("./native");

    expect(() => setCohort("a".repeat(65))).toThrow(
      INVALID_COHORT_ERROR_MESSAGE,
    );
    expect(nativeModuleMock.setCohort).not.toHaveBeenCalled();
  });

  it("returns the cohort reported by native", async () => {
    nativeModuleMock.getCohort.mockReturnValue("qa-group");

    const { getCohort } = await import("./native");

    expect(getCohort()).toBe("qa-group");
  });

  it("normalizes the cohort reported by native", async () => {
    nativeModuleMock.getCohort.mockReturnValue(" QA-GROUP ");

    const { getCohort } = await import("./native");

    expect(getCohort()).toBe("qa-group");
  });

  it("throws when native reports an invalid cohort", async () => {
    nativeModuleMock.getCohort.mockReturnValue("1001");

    const { getCohort } = await import("./native");

    expect(() => getCohort()).toThrow(INVALID_COHORT_ERROR_MESSAGE);
  });
});

import { INVALID_COHORT_ERROR_MESSAGE } from "@hot-updater/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  const getManifest = vi.fn<() => Record<string, unknown> | string>();
  const getCrashHistory = vi.fn<() => string[] | string>(() => []);

  return {
    getActiveUpdateState: vi.fn<() => unknown>(),
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn<() => string | null>(() => null),
    getBundleId: vi.fn<() => string | null>(() => "bundle-id"),
    getCohort: vi.fn<() => string>(() => "123"),
    getInstallId: vi.fn<() => string>(() => "install-id"),
    getStorageItem: vi.fn<(key: string) => string | null>(() => null),
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
    setStorageItem: vi.fn<(key: string, value: string | null) => void>(),
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
    nativeModuleMock.getActiveUpdateState.mockReset();
    nativeModuleMock.getActiveUpdateState.mockReturnValue({
      activeSelection: null,
      stableSelection: null,
      verificationPending: false,
      highestSeenCatalogs: {},
    });
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
    nativeModuleMock.getInstallId.mockReset();
    nativeModuleMock.getInstallId.mockReturnValue("install-id");
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
    nativeModuleMock.getStorageItem.mockReset();
    nativeModuleMock.getStorageItem.mockReturnValue(null);
    nativeModuleMock.setStorageItem.mockReset();
    nativeModuleMock.updateBundle.mockReset();
  });

  it("exposes active Release state without internal Catalog identity or history", async () => {
    const receipt = {
      bundleId: "bundle-123",
      releaseId: "release-123",
      kind: "BUNDLE",
      channel: "production",
      catalogId: "private-catalog",
      scopeKey: "private-scope",
      generation: 10,
      catalogHash: "private-hash",
      selectionContextHash: "private-context",
    };
    nativeModuleMock.getActiveUpdateState.mockReturnValue({
      activeSelection: receipt,
      stableSelection: receipt,
      verificationPending: true,
      highestSeenCatalogs: {
        "private-catalog|private-scope": {
          generation: 10,
          catalogHash: "private-hash",
        },
      },
    });
    const { getPublicActiveUpdateState } = await import("./native");
    const selection = {
      bundleId: "bundle-123",
      releaseId: "release-123",
      kind: "BUNDLE",
      channel: "production",
    };
    expect(getPublicActiveUpdateState()).toEqual({
      activeSelection: selection,
      stableSelection: selection,
      verificationPending: true,
    });
  });

  it("tracks same-file promotions without changing artifact or crash identities", async () => {
    const state = {
      activeSelection: {
        kind: "BUNDLE",
        bundleId: "bundle-123",
        releaseId: "release-1",
      },
    };
    nativeModuleMock.getActiveUpdateState.mockImplementation(() => state);
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.getManifest.mockReturnValue({ assets: {} });
    nativeModuleMock.getCrashHistory.mockReturnValue(["bundle-failed"]);
    const { getUpdateId, getBundleId, getManifest, getCrashHistory } =
      await import("./native");

    expect(getUpdateId()).toBe("release-1");
    state.activeSelection.releaseId = "release-2";
    expect(getUpdateId()).toBe("release-2");
    expect(getBundleId()).toBe("bundle-123");
    expect(getManifest().bundleId).toBe("bundle-123");
    expect(getCrashHistory()).toEqual(["bundle-failed"]);
  });

  it.each([
    [null, "min-bundle-id"],
    ["legacy-bundle", "legacy-bundle"],
  ])(
    "preserves the fallback ID for native bundle %s",
    async (bundleId, expected) => {
      nativeModuleMock.getBundleId.mockReturnValue(bundleId);
      const { getUpdateId } = await import("./native");

      expect(getUpdateId()).toBe(expected);
    },
  );

  it("reports a staged update while the manifest still identifies the running file", async () => {
    const runningSelection = {
      kind: "BUNDLE",
      bundleId: "running-file",
      releaseId: "running-update",
    };
    const state = {
      activeSelection: runningSelection,
      stableSelection: runningSelection,
    };
    nativeModuleMock.getActiveUpdateState.mockImplementation(() => state);
    nativeModuleMock.getBundleId.mockReturnValue("running-file");
    nativeModuleMock.getManifest.mockReturnValue({
      assets: {},
      bundleId: "running-file",
    });
    const { getUpdateId, getBundleId, getManifest } = await import("./native");

    expect(getUpdateId()).toBe("running-update");
    state.activeSelection = {
      kind: "BUNDLE",
      bundleId: "staged-file",
      releaseId: "staged-update",
    };

    expect(getUpdateId()).toBe("staged-update");
    expect(getBundleId()).toBe("running-file");
    expect(getManifest().bundleId).toBe("running-file");
  });

  it("reports an explicit built-in rollback by its update ID", async () => {
    nativeModuleMock.getActiveUpdateState.mockReturnValue(
      JSON.stringify({
        activeSelection: {
          kind: "EMBEDDED",
          releaseId: "rollback-1",
          bundleId: "min-bundle-id",
        },
      }),
    );
    nativeModuleMock.getBundleId.mockReturnValue(null);
    const { getUpdateId, getBundleId } = await import("./native");

    expect(getUpdateId()).toBe("rollback-1");
    expect(getBundleId()).toBe("min-bundle-id");
  });

  it("normalizes legacy PROMOTED launch reports to UPDATE_APPLIED", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue(
      JSON.stringify({
        fromBundleId: "bundle-123",
        status: "PROMOTED",
        toBundleId: "bundle-456",
      }),
    );

    const { notifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({
      fromBundleId: "bundle-123",
      status: "UPDATE_APPLIED",
      toBundleId: "bundle-456",
    });
    expect(nativeModuleMock.notifyAppReady).toHaveBeenCalledWith();
  });

  it("returns RECOVERED launch reports with directional ids", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      fromBundleId: "bundle-123",
      status: "RECOVERED",
      toBundleId: "bundle-122",
      updateStrategy: "appVersion",
    });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({
      fromBundleId: "bundle-123",
      status: "RECOVERED",
      toBundleId: "bundle-122",
    });
    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: null,
      transition: {
        fromBundleId: "bundle-123",
        fromReleaseId: null,
        toBundleId: "bundle-122",
        toReleaseId: null,
        type: "RECOVERED",
        updateStrategy: "appVersion",
      },
      pending: false,
      result: {
        fromBundleId: "bundle-123",
        status: "RECOVERED",
        toBundleId: "bundle-122",
      },
    });
  });

  it("returns UNCHANGED for incomplete recovery payloads", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      fromBundleId: "bundle-123",
      status: "RECOVERED",
      toBundleId: null,
      updateStrategy: "appVersion",
    });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: null,
      transition: null,
      pending: false,
      result: { status: "UNCHANGED" },
    });
  });

  it("returns UNCHANGED when an applied launch report has no bundle ids", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      status: "UPDATE_APPLIED",
    });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: null,
      transition: null,
      pending: false,
      result: { status: "UNCHANGED" },
    });
  });

  it("normalizes malformed old-arch notifyAppReady payloads to UNCHANGED", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue("{");

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: null,
      transition: null,
      pending: false,
      result: { status: "UNCHANGED" },
    });
  });

  it("keeps the internal pending state out of the public result", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({ status: "PENDING" });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: null,
      transition: null,
      pending: true,
      result: { status: "UNCHANGED" },
    });
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
      assets: {},
      bundleId: "bundle-456",
      archiveUrl: "https://example.com/bundle.tar.br",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE",
    });

    expect(getBundleId()).toBe("bundle-123");
    expect(nativeModuleMock.updateBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveUrl: "https://example.com/bundle.tar.br",
      }),
    );
    expect(getManifest()).toEqual({
      assets: {},
      bundleId: "bundle-123",
    });
    expect(getBaseURL()).toBe("file:///bundle-123");
    expect(nativeModuleMock.getBundleId).toHaveBeenCalledTimes(3);
    expect(nativeModuleMock.getManifest).toHaveBeenCalledTimes(2);
    expect(nativeModuleMock.getBaseURL).toHaveBeenCalledTimes(2);
  });

  it("reinstalls a session-installed bundle after native resets to built-in", async () => {
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "00000000-0000-0000-0000-000000000001",
    });
    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000002",
    );
    nativeModuleMock.updateBundle.mockResolvedValue(true);

    const { getBundleId, updateBundle } = await import("./native");

    await updateBundle({
      assets: {},
      bundleId: "00000000-0000-0000-0000-000000000003",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE",
    });

    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000003",
    );
    expect(getBundleId()).toBe("00000000-0000-0000-0000-000000000003");

    nativeModuleMock.getBundleId.mockReturnValue(null);

    await expect(
      updateBundle({
        assets: {},
        bundleId: "00000000-0000-0000-0000-000000000003",
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://example.com/manifest.json",
        status: "UPDATE",
      }),
    ).resolves.toBe(true);

    expect(nativeModuleMock.updateBundle).toHaveBeenCalledTimes(2);
  });

  it("skips a session-installed bundle when native still reports it active", async () => {
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "00000000-0000-0000-0000-000000000001",
    });
    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000002",
    );
    nativeModuleMock.updateBundle.mockResolvedValue(true);

    const { updateBundle } = await import("./native");

    await updateBundle({
      assets: {},
      bundleId: "00000000-0000-0000-0000-000000000003",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE",
    });

    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000003",
    );

    await expect(
      updateBundle({
        assets: {},
        bundleId: "00000000-0000-0000-0000-000000000003",
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://example.com/manifest.json",
        status: "UPDATE",
      }),
    ).resolves.toBe(true);

    expect(nativeModuleMock.updateBundle).toHaveBeenCalledTimes(1);
  });

  it("forwards manifest artifact parameters to native updateBundle", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.updateBundle.mockResolvedValue(true);

    const { updateBundle } = await import("./native");

    await updateBundle({
      bundleId: "bundle-789",
      assets: {
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
      manifestFileHash: "sig:manifest",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE",
    });

    expect(nativeModuleMock.updateBundle).toHaveBeenCalledWith({
      bundleId: "bundle-789",
      assets: {
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
      manifestFileHash: "sig:manifest",
      manifestUrl: "https://example.com/manifest.json",
    });
  });

  it("resolves how native delivered a staged bundle", async () => {
    nativeModuleMock.getBundleId.mockReturnValue("bundle-123");
    nativeModuleMock.updateBundle.mockResolvedValue({
      delivery: "patch",
      patchFallback: true,
    });
    const { stageBundle, updateBundle } = await import("./native");
    const params = {
      assets: {},
      bundleId: "bundle-789",
      manifestFileHash: "sig:manifest",
      manifestUrl: "https://example.com/manifest.json",
      status: "UPDATE" as const,
    };

    await expect(stageBundle(params)).resolves.toEqual({
      delivery: "patch",
      patchFallback: true,
    });
    // Native still reports bundle-123, so the same bundle downloads again.
    await expect(updateBundle(params)).resolves.toBe(true);
    nativeModuleMock.getBundleId.mockReturnValue("bundle-789");
    // Now native reports it: this runtime already staged it.
    await expect(stageBundle(params)).resolves.toBeNull();
    expect(nativeModuleMock.updateBundle).toHaveBeenCalledTimes(2);
  });

  it("passes on why the previous process exited from the launch report", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      previousProcessExit: "LOW_MEMORY",
      status: "UNCHANGED",
    });

    const { readNotifyAppReady } = await import("./native");

    expect(readNotifyAppReady()).toEqual({
      previousProcessExit: "LOW_MEMORY",
      transition: null,
      pending: false,
      result: { status: "UNCHANGED" },
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

  it("returns the install id reported by native", async () => {
    nativeModuleMock.getInstallId.mockReturnValue("install-123");

    const { getInstallId } = await import("./native");

    expect(getInstallId()).toBe("install-123");
  });

  it("normalizes an omitted native fingerprint constant to null", async () => {
    nativeModuleMock.getConstants.mockReturnValue({
      APP_VERSION: null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: undefined as unknown as null,
      MIN_BUNDLE_ID: "min-bundle-id",
    });

    const { getFingerprintHash } = await import("./native");

    expect(getFingerprintHash()).toBeNull();
  });

  it("throws when native SDK does not expose getInstallId", async () => {
    const nativeModule = nativeModuleMock as typeof nativeModuleMock & {
      getInstallId?: typeof nativeModuleMock.getInstallId;
    };
    const originalGetInstallId = nativeModule.getInstallId;
    nativeModule.getInstallId = null as unknown as Mock<() => string>;

    try {
      const { getInstallId } = await import("./native");

      expect(() => getInstallId()).toThrow(
        "Native module is missing 'getInstallId()'",
      );
    } finally {
      nativeModule.getInstallId = originalGetInstallId;
    }
  });

  it("reads and writes the native key-value store", async () => {
    nativeModuleMock.getStorageItem.mockImplementation((key) =>
      key === "plugins/example/state" ? "stored" : null,
    );
    const { getStorageItem, setStorageItem } = await import("./native");

    expect(getStorageItem("plugins/example/state")).toBe("stored");
    expect(getStorageItem("plugins/example/missing")).toBeNull();
    setStorageItem("plugins/example/state", "next");
    setStorageItem("plugins/example/state", null);

    expect(nativeModuleMock.setStorageItem).toHaveBeenNthCalledWith(
      1,
      "plugins/example/state",
      "next",
    );
    expect(nativeModuleMock.setStorageItem).toHaveBeenNthCalledWith(
      2,
      "plugins/example/state",
      null,
    );
  });

  it.each(["getStorageItem", "setStorageItem"] as const)(
    "throws when native SDK does not expose %s",
    async (name) => {
      const nativeModule = nativeModuleMock as Record<string, unknown>;
      const original = nativeModule[name];
      nativeModule[name] = undefined;

      try {
        const { getStorageItem, setStorageItem } = await import("./native");

        expect(() =>
          name === "getStorageItem"
            ? getStorageItem("key")
            : setStorageItem("key", "value"),
        ).toThrow(`Native module is missing '${name}()'`);
      } finally {
        nativeModule[name] = original;
      }
    },
  );

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

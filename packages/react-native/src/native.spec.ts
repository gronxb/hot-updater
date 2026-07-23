import { INVALID_COHORT_ERROR_MESSAGE } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModuleMock = vi.hoisted(() => {
  const getManifest = vi.fn<() => Record<string, unknown> | string>();
  const getCrashHistory = vi.fn<() => string[] | string>(() => []);

  return {
    clearCrashHistory: vi.fn(() => true),
    getBaseURL: vi.fn<() => string | null>(() => null),
    getBundleId: vi.fn<() => string | null>(() => "bundle-id"),
    getCohort: vi.fn<() => string>(() => "123"),
    getInstallId: vi.fn<() => string>(() => "install-id"),
    getUserId: vi.fn<() => string | null>(() => null),
    getUsername: vi.fn<() => string | null>(() => null),
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
    setUser: vi.fn(),
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
    nativeModuleMock.setUser.mockReset();
    nativeModuleMock.updateBundle.mockReset();
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
      analyticsEvent: {
        fromBundleId: "bundle-123",
        toBundleId: "bundle-122",
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

  it("preserves recovery from legacy native object payloads", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      crashedBundleId: "bundle-crashed",
      status: "RECOVERED",
    });
    nativeModuleMock.getBundleId.mockReturnValue("bundle-recovered");

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({
      fromBundleId: "bundle-crashed",
      status: "RECOVERED",
      toBundleId: "bundle-recovered",
    });
    expect(readNotifyAppReady()).toEqual({
      analyticsEvent: null,
      pending: false,
      result: {
        fromBundleId: "bundle-crashed",
        status: "RECOVERED",
        toBundleId: "bundle-recovered",
      },
    });
  });

  it("preserves recovery from legacy Android JSON payloads", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue(
      JSON.stringify({
        crashedBundleId: "bundle-crashed",
        status: "RECOVERED",
      }),
    );
    nativeModuleMock.getBundleId.mockReturnValue("bundle-recovered");

    const { readNotifyAppReady } = await import("./native");

    expect(readNotifyAppReady()).toEqual({
      analyticsEvent: null,
      pending: false,
      result: {
        fromBundleId: "bundle-crashed",
        status: "RECOVERED",
        toBundleId: "bundle-recovered",
      },
    });
  });

  it("returns UNCHANGED when automatic analytics metadata is incomplete", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({
      status: "UPDATE_APPLIED",
    });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      analyticsEvent: null,
      pending: false,
      result: { status: "UNCHANGED" },
    });
  });

  it("normalizes malformed old-arch notifyAppReady payloads to UNCHANGED", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue("{");

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      analyticsEvent: null,
      pending: false,
      result: { status: "UNCHANGED" },
    });
  });

  it("keeps the internal pending state out of the public result", async () => {
    nativeModuleMock.notifyAppReady.mockReturnValue({ status: "PENDING" });

    const { notifyAppReady, readNotifyAppReady } = await import("./native");

    expect(notifyAppReady()).toEqual({ status: "UNCHANGED" });
    expect(readNotifyAppReady()).toEqual({
      analyticsEvent: null,
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
    const originalGetBundleId = nativeModuleMock.getBundleId;
    Reflect.set(nativeModuleMock, "getBundleId", null);

    try {
      const { getBundleId } = await import("./native");

      expect(() => getBundleId()).toThrow(
        "Native module is missing 'getBundleId()'",
      );
    } finally {
      Reflect.set(nativeModuleMock, "getBundleId", originalGetBundleId);
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
      bundleId: "00000000-0000-0000-0000-000000000003",
      fileHash: null,
      fileUrl: "https://example.com/bundle.zip",
      status: "UPDATE",
    });

    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000003",
    );
    expect(getBundleId()).toBe("00000000-0000-0000-0000-000000000003");

    nativeModuleMock.getBundleId.mockReturnValue(null);

    await expect(
      updateBundle({
        bundleId: "00000000-0000-0000-0000-000000000003",
        fileHash: null,
        fileUrl: "https://example.com/bundle.zip",
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
      bundleId: "00000000-0000-0000-0000-000000000003",
      fileHash: null,
      fileUrl: "https://example.com/bundle.zip",
      status: "UPDATE",
    });

    nativeModuleMock.getBundleId.mockReturnValue(
      "00000000-0000-0000-0000-000000000003",
    );

    await expect(
      updateBundle({
        bundleId: "00000000-0000-0000-0000-000000000003",
        fileHash: null,
        fileUrl: "https://example.com/bundle.zip",
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

  it("returns the install id reported by native", async () => {
    nativeModuleMock.getInstallId.mockReturnValue("install-123");

    const { getInstallId } = await import("./native");

    expect(getInstallId()).toBe("install-123");
  });

  it("throws when native SDK does not expose getInstallId", async () => {
    const originalGetInstallId = nativeModuleMock.getInstallId;
    Reflect.set(nativeModuleMock, "getInstallId", null);

    try {
      const { getInstallId } = await import("./native");

      expect(() => getInstallId()).toThrow(
        "Native module is missing 'getInstallId()'",
      );
    } finally {
      Reflect.set(nativeModuleMock, "getInstallId", originalGetInstallId);
    }
  });

  it("passes nullable user identity through to native", async () => {
    const { setUser } = await import("./native");

    setUser({ userId: "user-123", username: "alice" });
    setUser({ userId: 42, username: "bob" });
    setUser({});
    setUser(null);

    expect(nativeModuleMock.setUser).toHaveBeenNthCalledWith(
      1,
      "user-123",
      "alice",
    );
    expect(nativeModuleMock.setUser).toHaveBeenNthCalledWith(2, "42", "bob");
    expect(nativeModuleMock.setUser).toHaveBeenNthCalledWith(3, null, null);
    expect(nativeModuleMock.setUser).toHaveBeenNthCalledWith(4, null, null);
  });

  it("reads persisted user identity from native when available", async () => {
    nativeModuleMock.getUserId.mockReturnValue("user-123");
    nativeModuleMock.getUsername.mockReturnValue("alice");

    const { getPersistedUserIdentity } = await import("./native");

    expect(getPersistedUserIdentity()).toEqual({
      userId: "user-123",
      username: "alice",
    });
  });

  it("throws when native SDK does not expose persisted user identity getters", async () => {
    const originalGetUserId = nativeModuleMock.getUserId;
    Reflect.set(nativeModuleMock, "getUserId", null);

    try {
      const { getPersistedUserIdentity } = await import("./native");

      expect(() => getPersistedUserIdentity()).toThrow(
        "Native module is missing 'getUserId()' or 'getUsername()'",
      );
    } finally {
      Reflect.set(nativeModuleMock, "getUserId", originalGetUserId);
    }
  });

  it("throws when native SDK does not expose setUser", async () => {
    const originalSetUser = nativeModuleMock.setUser;
    Reflect.set(nativeModuleMock, "setUser", null);

    try {
      const { setUser } = await import("./native");

      expect(() => setUser({ userId: "user-123" })).toThrow(
        "Native module is missing 'setUser()'",
      );
    } finally {
      Reflect.set(nativeModuleMock, "setUser", originalSetUser);
    }
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

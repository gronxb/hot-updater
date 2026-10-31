import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => {
  const base = {
    getConstants: () => ({
      APP_VERSION: "1.0.0" as string | null,
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: "fingerprint",
      MIN_BUNDLE_ID: "min-bundle",
    }),
    getBundleId: vi.fn((): string | null => "selected-bundle"),
  };
  return base as typeof base & {
    getUpdateStatus?: () => Promise<string>;
    getUpdateLogs?: () => Promise<string>;
    clearUpdateLogs?: () => Promise<boolean>;
    appendUpdateLog?: (entry: string) => void;
  };
});
const platform = vi.hoisted(() => ({ OS: "ios" }));

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
  Platform: platform,
}));
vi.mock("./specs/NativeHotUpdater", () => ({ default: nativeModule }));

import {
  clearUpdateLogs,
  getUpdateLogs,
  getUpdateStatus,
  recordUpdateLog,
} from "./updateDiagnostics";

const withoutNativeMethods = () => {
  delete nativeModule.getUpdateStatus;
  delete nativeModule.getUpdateLogs;
  delete nativeModule.clearUpdateLogs;
  delete nativeModule.appendUpdateLog;
};

describe("update status", () => {
  beforeEach(() => {
    withoutNativeMethods();
    platform.OS = "ios";
    vi.stubGlobal("__DEV__", false);
  });

  it("reports a pending bundle and the running one from native", async () => {
    nativeModule.getUpdateStatus = async () =>
      JSON.stringify({ bundleId: "running", pendingBundleId: "next" });

    await expect(getUpdateStatus()).resolves.toEqual({
      isEnabled: true,
      disabledReason: null,
      isUpdatePending: true,
      pendingBundleId: "next",
      bundleId: "running",
      channel: "production",
      appVersion: "1.0.0",
      fingerprintHash: "fingerprint",
      minBundleId: "min-bundle",
    });
  });

  it("reports nothing pending when the next launch runs the running bundle", async () => {
    nativeModule.getUpdateStatus = async () =>
      JSON.stringify({ bundleId: "running", pendingBundleId: null });

    const status = await getUpdateStatus();

    expect(status.isUpdatePending).toBe(false);
    expect(status.pendingBundleId).toBeNull();
  });

  it("is disabled in a development bundle, as checkForUpdate is", async () => {
    vi.stubGlobal("__DEV__", true);

    await expect(getUpdateStatus()).resolves.toMatchObject({
      isEnabled: false,
      disabledReason: "DEVELOPMENT_BUILD",
    });
  });

  it("is disabled without an app version, as checkForUpdate is", async () => {
    const getConstants = nativeModule.getConstants;
    nativeModule.getConstants = () => ({
      ...getConstants(),
      APP_VERSION: null,
    });
    try {
      await expect(getUpdateStatus()).resolves.toMatchObject({
        isEnabled: false,
        disabledReason: "MISSING_APP_VERSION",
      });
    } finally {
      nativeModule.getConstants = getConstants;
    }
  });

  it("is disabled on a platform Hot Updater does not run on", async () => {
    platform.OS = "web";

    await expect(getUpdateStatus()).resolves.toMatchObject({
      isEnabled: false,
      disabledReason: "UNSUPPORTED_PLATFORM",
    });
  });

  it("says pending is unknown on native built from an earlier SDK", async () => {
    await expect(getUpdateStatus()).resolves.toEqual({
      isEnabled: true,
      disabledReason: null,
      isUpdatePending: null,
      pendingBundleId: null,
      bundleId: "selected-bundle",
      channel: "production",
      appVersion: "1.0.0",
      fingerprintHash: "fingerprint",
      minBundleId: "min-bundle",
    });
  });

  it.each([
    ["a rejection", () => Promise.reject(new Error("failed"))],
    ["unreadable JSON", async () => "{"],
    ["no running bundle", async () => JSON.stringify({})],
  ])("says pending is unknown after %s", async (_, read) => {
    nativeModule.getUpdateStatus = read;

    await expect(getUpdateStatus()).resolves.toMatchObject({
      isUpdatePending: null,
      bundleId: "selected-bundle",
    });
  });
});

describe("update logs", () => {
  const now = 1_000_000_000;
  const entry = (timestamp: number, bundleId: string) => ({
    timestamp,
    type: "DOWNLOAD",
    outcome: "STAGED",
    bundleId,
    channel: "production",
  });

  beforeEach(() => {
    withoutNativeMethods();
    vi.spyOn(Date, "now").mockReturnValue(now);
  });

  it("returns the newest entries first, with every field", async () => {
    nativeModule.getUpdateLogs = async () =>
      JSON.stringify([
        entry(now - 2, "older"),
        {
          timestamp: now - 1,
          type: "CHECK",
          outcome: "FAILED",
          channel: "beta",
          error: {
            code: "E",
            message: "failed",
            stage: "check",
            reason: "http",
          },
        },
      ]);

    await expect(getUpdateLogs()).resolves.toEqual([
      {
        timestamp: now - 1,
        type: "CHECK",
        outcome: "FAILED",
        bundleId: null,
        fromBundleId: null,
        releaseId: null,
        channel: "beta",
        error: { code: "E", message: "failed", stage: "check", reason: "http" },
      },
      {
        timestamp: now - 2,
        type: "DOWNLOAD",
        outcome: "STAGED",
        bundleId: "older",
        fromBundleId: null,
        releaseId: null,
        channel: "production",
        error: null,
      },
    ]);
  });

  it("filters by age, then keeps the newest within the limit", async () => {
    nativeModule.getUpdateLogs = async () =>
      JSON.stringify([
        entry(now - 300, "too-old"),
        entry(now - 200, "a"),
        entry(now - 100, "b"),
        entry(now, "c"),
      ]);

    const logs = await getUpdateLogs({ maxAge: 200, limit: 2 });

    expect(logs?.map(({ bundleId }) => bundleId)).toEqual(["c", "b"]);
  });

  it("skips entries it cannot read and survives an unreadable log", async () => {
    nativeModule.getUpdateLogs = async () =>
      JSON.stringify([null, 1, { type: "CHECK" }, entry(now, "kept")]);
    const logs = await getUpdateLogs();
    expect(logs?.map(({ bundleId }) => bundleId)).toEqual(["kept"]);

    nativeModule.getUpdateLogs = async () => "not json";
    await expect(getUpdateLogs()).resolves.toEqual([]);
  });

  it("tells a build without the log from an empty log", async () => {
    await expect(getUpdateLogs()).resolves.toBeNull();

    nativeModule.getUpdateLogs = async () => "[]";
    await expect(getUpdateLogs()).resolves.toEqual([]);
  });

  it("clears through native, and reports false without the log", async () => {
    await expect(clearUpdateLogs()).resolves.toBe(false);

    nativeModule.clearUpdateLogs = vi.fn(async () => true);
    await expect(clearUpdateLogs()).resolves.toBe(true);
    expect(nativeModule.clearUpdateLogs).toHaveBeenCalledOnce();
  });
});

describe("recordUpdateLog", () => {
  beforeEach(withoutNativeMethods);

  it("does nothing on native without the log", () => {
    expect(() =>
      recordUpdateLog({ type: "CHECK", outcome: "UP_TO_DATE" }),
    ).not.toThrow();
  });

  it("appends the check as JSON, without a time native stamps", () => {
    const appendUpdateLog = vi.fn();
    nativeModule.appendUpdateLog = appendUpdateLog;

    recordUpdateLog({
      type: "CHECK",
      outcome: "UPDATE_AVAILABLE",
      bundleId: "target",
      fromBundleId: "running",
      releaseId: "release",
      channel: "production",
    });

    expect(JSON.parse(appendUpdateLog.mock.calls[0]?.[0])).toEqual({
      type: "CHECK",
      outcome: "UPDATE_AVAILABLE",
      bundleId: "target",
      fromBundleId: "running",
      releaseId: "release",
      channel: "production",
    });
  });

  it("describes a native error and any thrown value", () => {
    const appendUpdateLog = vi.fn();
    nativeModule.appendUpdateLog = appendUpdateLog;
    const nativeError = Object.assign(new Error("failed"), {
      code: "DOWNLOAD_FAILED",
      userInfo: { stage: "download", reason: "network" },
    });

    recordUpdateLog({ type: "CHECK", outcome: "FAILED", error: nativeError });
    recordUpdateLog({ type: "CHECK", outcome: "FAILED", error: "text" });

    expect(JSON.parse(appendUpdateLog.mock.calls[0]?.[0]).error).toEqual({
      code: "DOWNLOAD_FAILED",
      message: "failed",
      stage: "download",
      reason: "network",
    });
    expect(JSON.parse(appendUpdateLog.mock.calls[1]?.[0]).error).toEqual({
      message: "text",
    });
  });

  it("never lets a failure to record reach the check", () => {
    nativeModule.appendUpdateLog = () => {
      throw new Error("native failed");
    };

    expect(() =>
      recordUpdateLog({ type: "CHECK", outcome: "UP_TO_DATE" }),
    ).not.toThrow();
  });
});

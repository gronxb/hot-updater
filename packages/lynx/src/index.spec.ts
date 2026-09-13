import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfirmationResult, NativeReply, NativeState } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Lynx public controller", () => {
  it("omits public APIs without truthful native behavior", async () => {
    const { HotUpdater } = await import("./index");
    expect("getManifest" in HotUpdater).toBe(false);
    expect("getInstallId" in HotUpdater).toBe(false);
    expect("addListener" in HotUpdater).toBe(false);
    expect("setUser" in HotUpdater).toBe(false);
  });

  it("propagates missing native managed reload support", async () => {
    vi.stubGlobal("NativeModules", undefined);
    const { HotUpdater } = await import("./index");
    await expect(HotUpdater.reload()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
  });

  it("requires a real handler for the only custom reload behavior", async () => {
    const { HotUpdater } = await import("./index");
    const setReloadBehavior = HotUpdater.setReloadBehavior as unknown as (
      behavior: string,
      handler?: () => void | Promise<void>,
    ) => void;
    expect(() => setReloadBehavior("custom")).toThrow(
      'HotUpdater.setReloadBehavior("custom") requires a reload handler.',
    );
    expect(() => setReloadBehavior("processRestart", vi.fn())).toThrow(
      'HotUpdater.setReloadBehavior("custom") requires a reload handler.',
    );

    const handler = vi.fn(async () => undefined);
    HotUpdater.setReloadBehavior("custom", handler);
    await HotUpdater.reload();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("imports and creates without reading native globals or starting HTTP", async () => {
    const readModule = vi.fn(() => {
      throw new Error("Native access during import");
    });
    vi.stubGlobal(
      "NativeModules",
      Object.defineProperty({}, "HotUpdaterLynx", { get: readModule }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    expect(readModule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(HotUpdater.getLaunchInfo()).rejects.toThrow(
      "Native access during import",
    );
    expect(readModule).toHaveBeenCalledOnce();
  });

  it("reports native running identity separately from an installed next release", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "A",
      releaseId: "release-A",
      channel: "production",
    };
    const next = { ...running, bundleId: "B", releaseId: "release-B" };
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "android",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              nextSelection: next as NativeState["nextSelection"],
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    const info = await HotUpdater.getLaunchInfo();
    expect(info).toEqual({
      platform: "android",
      runtimeId: "runtime",
      running,
      next,
      confirmed: true,
    });
    expect(HotUpdater.getBundleId()).toBe("release-A");
    expect(HotUpdater.isUpdateDownloaded()).toBe(true);
    Object.assign(info.running, { bundleId: "changed" });
    expect((await HotUpdater.getLaunchInfo()).running.bundleId).toBe("A");
    expect(HotUpdater.getBundleId()).toBe("release-A");
  });

  it("invalidates its snapshot without racing generation teardown after reset", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "A",
      releaseId: "release-A",
      channel: "production",
    };
    const state = {
      platform: "ios" as const,
      runtimeId: "runtime",
      runningSelection: running,
      runningConfirmed: true,
      nextSelection: { ...running, bundleId: "B", releaseId: "release-B" },
      crashedBundleIds: [],
      unconfirmedReleaseIds: [],
    } as unknown as NativeState;
    const getState = vi.fn(
      (callback: (reply: NativeReply<NativeState>) => void) => {
        if (getState.mock.calls.length > 1) {
          callback({
            ok: false,
            error: {
              code: "GENERATION_RETIRED",
              message: "The reset generation has been destroyed.",
            },
          });
          return;
        }
        callback({ ok: true, data: state });
      },
    );
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState,
        resetChannel: (
          callback: (reply: NativeReply<{ reset: boolean }>) => void,
        ) => {
          state.nextSelection = null;
          callback({ ok: true, data: { reset: true } });
        },
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });

    await HotUpdater.getLaunchInfo();
    expect(HotUpdater.isUpdateDownloaded()).toBe(true);
    await expect(HotUpdater.resetChannel()).resolves.toBe(true);
    expect(getState).toHaveBeenCalledOnce();
    expect(() => HotUpdater.isUpdateDownloaded()).toThrow(
      "Call HotUpdater.notifyAppReady() or HotUpdater.checkForUpdate()",
    );
  });

  it("propagates reset failure and invalidates potentially stale state", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "A",
      releaseId: "release-A",
      channel: "production",
    };
    const state = {
      platform: "android" as const,
      runtimeId: "runtime",
      channel: "beta",
      defaultChannel: "production",
      runningSelection: running,
      runningConfirmed: true,
      nextSelection: { ...running, bundleId: "B", releaseId: "release-B" },
      crashedBundleIds: [],
      unconfirmedReleaseIds: [],
    } as unknown as NativeState;
    const getState = vi.fn(
      (callback: (reply: NativeReply<NativeState>) => void) =>
        callback({ ok: true, data: state }),
    );
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState,
        resetChannel: (
          callback: (reply: NativeReply<{ reset: boolean }>) => void,
        ) =>
          callback({
            ok: false,
            error: {
              code: "STATE_WRITE_FAILED",
              message: "Reset was not committed.",
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });

    await HotUpdater.getLaunchInfo();
    expect(HotUpdater.getChannel()).toBe("beta");
    expect(HotUpdater.isUpdateDownloaded()).toBe(true);
    await expect(HotUpdater.resetChannel()).rejects.toMatchObject({
      code: "STATE_WRITE_FAILED",
    });
    expect(getState).toHaveBeenCalledOnce();
    expect(() => HotUpdater.getChannel()).toThrow(
      "Call HotUpdater.notifyAppReady() or HotUpdater.checkForUpdate()",
    );
    expect(() => HotUpdater.isUpdateDownloaded()).toThrow(
      "Call HotUpdater.notifyAppReady() or HotUpdater.checkForUpdate()",
    );
  });

  it("reports a native recovery receipt once without reusing durable crash history", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "stable",
      releaseId: "release-stable",
      channel: "production",
    };
    const notifyAppReady = vi.fn(
      (callback: (reply: NativeReply<ConfirmationResult>) => void) =>
        callback({
          ok: true,
          data: {
            status: "ALREADY_CONFIRMED",
            transition:
              notifyAppReady.mock.calls.length === 1
                ? {
                    kind: "RECOVERED",
                    from: {
                      kind: "BUNDLE",
                      bundleId: "crash",
                      releaseId: "release-crash",
                      channel: "production",
                    },
                    to: running,
                  }
                : null,
          },
        }),
    );
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "ios",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              crashedBundleIds: ["crash"],
              embeddedBundleId: "embedded",
            },
          }),
        notifyAppReady,
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
      status: "RECOVERED",
      fromBundleId: "crash",
      toBundleId: "stable",
      fromReleaseId: "release-crash",
      toReleaseId: "release-stable",
    });
    await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
      status: "UNCHANGED",
    });
  });

  it("reads crash history from array-like native lists without Array.at", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "stable",
      releaseId: "release-stable",
      channel: "production",
    };
    const crashedBundleIds = Object.assign(Object.create(null), {
      0: "crash",
      length: 1,
    }) as unknown as string[];
    expect(typeof (crashedBundleIds as { at?: unknown }).at).toBe("undefined");
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "android",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              crashedBundleIds,
              embeddedBundleId: "embedded",
            },
          }),
        notifyAppReady: (
          callback: (reply: NativeReply<ConfirmationResult>) => void,
        ) =>
          callback({
            ok: true,
            data: { status: "ALREADY_CONFIRMED", transition: null },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
      status: "UNCHANGED",
    });
    expect(HotUpdater.getCrashHistory()).toEqual(["crash"]);
  });

  it.each([
    {
      name: "embedded",
      from: {
        kind: "BUILTIN" as const,
        bundleId: "embedded-A",
        releaseId: null,
        channel: "production",
      },
    },
    {
      name: "confirmed",
      from: {
        kind: "BUNDLE" as const,
        bundleId: "bundle-A",
        releaseId: "release-A",
        channel: "production",
      },
    },
  ])(
    "reports the authoritative $name A to launched B transition",
    async ({ from }) => {
      const running = {
        kind: "BUNDLE" as const,
        bundleId: "bundle-B",
        releaseId: "release-B",
        channel: "production",
      };
      vi.stubGlobal("NativeModules", {
        HotUpdaterLynx: {
          getState: (
            callback: (reply: NativeReply<Partial<NativeState>>) => void,
          ) =>
            callback({
              ok: true,
              data: {
                platform: "ios",
                runtimeId: "runtime",
                runningSelection: running as NativeState["runningSelection"],
                runningConfirmed: false,
                crashedBundleIds: [],
              },
            }),
          notifyAppReady: (
            callback: (reply: NativeReply<ConfirmationResult>) => void,
          ) =>
            callback({
              ok: true,
              data: {
                status: "CONFIRMED",
                transition: { kind: "UPDATE_APPLIED", from, to: running },
              },
            }),
        },
      });
      const { HotUpdater } = await import("./index");
      HotUpdater.init({ baseURL: "https://updates.test" });
      await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
        status: "UPDATE_APPLIED",
        fromBundleId: from.bundleId,
        toBundleId: "bundle-B",
        ...(from.releaseId === null ? {} : { fromReleaseId: from.releaseId }),
        toReleaseId: "release-B",
      });
    },
  );

  it("reports same-bundle new-Release adoption as directional UNCHANGED", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "bundle-B",
      releaseId: "release-new",
      channel: "beta",
    };
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "android",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              crashedBundleIds: [],
            },
          }),
        notifyAppReady: (
          callback: (reply: NativeReply<ConfirmationResult>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              status: "ALREADY_CONFIRMED",
              transition: {
                kind: "UNCHANGED",
                from: { ...running, releaseId: "release-old" },
                to: running,
              },
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
      status: "UNCHANGED",
      fromReleaseId: "release-old",
      toReleaseId: "release-new",
    });
  });

  it("rejects same-bundle adoption mislabeled UPDATE_APPLIED", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "bundle-B",
      releaseId: "release-new",
      channel: "production",
    };
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "ios",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              crashedBundleIds: [],
            },
          }),
        notifyAppReady: (
          callback: (reply: NativeReply<ConfirmationResult>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              status: "CONFIRMED",
              transition: {
                kind: "UPDATE_APPLIED",
                from: { ...running, releaseId: "release-old" },
                to: running,
              },
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).rejects.toMatchObject({
      code: "INVALID_NATIVE_REPLY",
    });
  });

  it("rejects a same-identity UPDATE_APPLIED receipt", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "bundle-B",
      releaseId: "release-B",
      channel: "production",
    };
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "android",
              runtimeId: "runtime",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
              crashedBundleIds: [],
            },
          }),
        notifyAppReady: (
          callback: (reply: NativeReply<ConfirmationResult>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              status: "CONFIRMED",
              transition: {
                kind: "UPDATE_APPLIED",
                from: running,
                to: running,
              },
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).rejects.toMatchObject({
      code: "INVALID_NATIVE_REPLY",
    });
  });

  it("reports a switched channel against the native default", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "A",
      releaseId: "release-A",
      channel: "beta",
    };
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) =>
          callback({
            ok: true,
            data: {
              platform: "android",
              runtimeId: "runtime",
              channel: "beta",
              defaultChannel: "production",
              runningSelection: running as NativeState["runningSelection"],
              runningConfirmed: true,
            },
          }),
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await HotUpdater.getLaunchInfo();
    expect(HotUpdater.getChannel()).toBe("beta");
    expect(HotUpdater.getDefaultChannel()).toBe("production");
    expect(HotUpdater.isChannelSwitched()).toBe(true);
    expect("setChannel" in HotUpdater).toBe(false);
  });

  it("normalizes a valid cohort before native persistence", async () => {
    const state = {
      platform: "android",
      runtimeId: "runtime",
      cohort: "123",
      crashedBundleIds: [],
      unconfirmedReleaseIds: [],
    } as unknown as NativeState;
    const setCohort = vi.fn(
      (
        params: { cohort: string },
        callback: (reply: NativeReply<NativeState>) => void,
      ) => {
        state.cohort = params.cohort;
        callback({ ok: true, data: state });
      },
    );
    vi.stubGlobal("NativeModules", { HotUpdaterLynx: { setCohort } });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });

    await HotUpdater.setCohort(" QA-Group ");

    expect(setCohort).toHaveBeenCalledWith(
      { cohort: "qa-group" },
      expect.any(Function),
    );
    expect(HotUpdater.getCohort()).toBe("qa-group");
  });

  it("normalizes array-like native lists returned after setting a cohort", async () => {
    const state = {
      platform: "ios",
      runtimeId: "runtime",
      cohort: "1",
      crashedBundleIds: { 0: "crashed", length: 1 },
      unconfirmedReleaseIds: { 0: "release-pending", length: 1 },
    } as unknown as NativeState;
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        setCohort: (
          params: { cohort: string },
          callback: (reply: NativeReply<NativeState>) => void,
        ) => {
          state.cohort = params.cohort;
          callback({ ok: true, data: state });
        },
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });

    await HotUpdater.setCohort(" QA-Group ");

    expect(HotUpdater.getCohort()).toBe("qa-group");
    expect(HotUpdater.getCrashHistory()).toEqual(["crashed"]);
  });

  it.each(["", "Bad Cohort", "a".repeat(65), "0", "1001"])(
    "rejects invalid cohort %j before native mutation",
    async (cohort) => {
      const setCohort = vi.fn();
      vi.stubGlobal("NativeModules", { HotUpdaterLynx: { setCohort } });
      const { HotUpdater } = await import("./index");
      HotUpdater.init({ baseURL: "https://updates.test" });

      expect(() => HotUpdater.setCohort(cohort)).toThrow(
        "Invalid cohort. Use 1-1000",
      );
      expect(setCohort).not.toHaveBeenCalled();
    },
  );

  it("waits for crash-history mutation and the refreshed native snapshot", async () => {
    const running = {
      kind: "BUNDLE" as const,
      bundleId: "stable",
      releaseId: "release-stable",
      channel: "production",
    };
    let crashHistory = ["crashed"];
    let clearCallback:
      | ((reply: NativeReply<Partial<NativeState>>) => void)
      | undefined;
    let refreshCallback:
      | ((reply: NativeReply<Partial<NativeState>>) => void)
      | undefined;
    let getStateCalls = 0;
    const state = (): Partial<NativeState> => ({
      platform: "ios",
      runtimeId: "runtime",
      runningSelection: running as NativeState["runningSelection"],
      runningConfirmed: true,
      crashedBundleIds: crashHistory,
      unconfirmedReleaseIds: [],
    });
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) => {
          getStateCalls += 1;
          if (getStateCalls === 1) {
            callback({ ok: true, data: state() });
          } else {
            refreshCallback = callback;
          }
        },
        clearCrashHistory: (
          callback: (reply: NativeReply<Partial<NativeState>>) => void,
        ) => {
          clearCallback = callback;
        },
      },
    });
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await HotUpdater.getLaunchInfo();

    let resolved = false;
    const clearing = HotUpdater.clearCrashHistory().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getStateCalls).toBe(1);

    crashHistory = [];
    clearCallback!({ ok: true, data: state() });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getStateCalls).toBe(2);

    refreshCallback!({ ok: true, data: state() });
    await clearing;
    expect(HotUpdater.getCrashHistory()).toEqual([]);
  });

  it("fails explicitly on a method call when native integration is absent", async () => {
    vi.stubGlobal("NativeModules", undefined);
    const { HotUpdater } = await import("./index");
    HotUpdater.init({ baseURL: "https://updates.test" });
    await expect(HotUpdater.notifyAppReady()).rejects.toMatchObject({
      code: "NATIVE_MODULE_UNAVAILABLE",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeReply, NativeState } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Lynx public controller", () => {
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
    Object.assign(info.running, { bundleId: "changed" });
    expect((await HotUpdater.getLaunchInfo()).running.bundleId).toBe("A");
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

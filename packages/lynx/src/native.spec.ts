import { afterEach, describe, expect, it, vi } from "vitest";

import { callNative, LynxUpdaterError } from "./native";

afterEach(() => vi.unstubAllGlobals());

describe("Lynx native callback transport", () => {
  it("normalizes stale native finalization into the public race error", async () => {
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        stageSelection: (_params: object, callback: (reply: unknown) => void) =>
          callback({
            ok: false,
            error: {
              code: "STALE_SELECTION",
              message: "Native finalization did not authorize publication",
            },
          }),
      },
    });

    await expect(
      callNative("stageSelection", { preparedId: "prepared-a" }),
    ).rejects.toMatchObject({
      code: "STALE_SELECTION",
      message: "Release catalog selection became stale before it was committed",
    });
  });

  it("preserves asynchronous native readiness rejection instead of reporting confirmation", async () => {
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        notifyAppReady: (callback: (value: unknown) => void) =>
          queueMicrotask(() =>
            callback({
              ok: false,
              error: {
                code: "STALE_CONTEXT",
                message: "The context was destroyed.",
              },
            }),
          ),
      },
    });
    await expect(callNative("notifyAppReady")).rejects.toBeInstanceOf(
      LynxUpdaterError,
    );
    await expect(callNative("notifyAppReady")).rejects.toMatchObject({
      code: "STALE_CONTEXT",
      message: "The context was destroyed.",
    });
  });

  it("rejects malformed native responses rather than accepting a false success", async () => {
    vi.stubGlobal("NativeModules", {
      HotUpdaterLynx: {
        getState: (callback: (value: unknown) => void) =>
          callback({ success: true }),
      },
    });
    await expect(callNative("getState")).rejects.toMatchObject({
      code: "INVALID_NATIVE_REPLY",
    });
  });

  it("preserves the native receiver and does not pass invented attempt IDs to readiness", async () => {
    const module = {
      notifyAppReady: vi.fn(function (
        this: unknown,
        callback: (value: unknown) => void,
      ) {
        expect(this).toBe(module);
        callback({
          ok: true,
          data: {
            status: "ALREADY_CONFIRMED",
            transitionId: null,
            transition: null,
          },
        });
      }),
    };
    vi.stubGlobal("NativeModules", { HotUpdaterLynx: module });
    await expect(callNative("notifyAppReady")).resolves.toEqual({
      status: "ALREADY_CONFIRMED",
      transitionId: null,
      transition: null,
    });
    expect(module.notifyAppReady.mock.calls[0]).toHaveLength(1);
  });
});

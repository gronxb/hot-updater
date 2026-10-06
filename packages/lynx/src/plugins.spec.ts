import type { HotUpdaterClientContext } from "@hot-updater/protocol";
import { afterEach, expect, it, vi } from "vitest";

import type { ConfirmationResult, NativeReply, NativeState } from "./types";

const bundleId = "00000000-0000-7000-8000-000000000001";
const releaseId = "00000000-0000-7000-8000-000000000002";

async function setup(
  confirmation: ConfirmationResult = {
    status: "CONFIRMED",
    transition: null,
    transitionId: null,
  },
) {
  const selection = {
    kind: "BUNDLE" as const,
    bundleId,
    releaseId,
    channel: "production",
    catalogId: "catalog",
    scopeKey: "v1:app-version:android:cHJvZHVjdGlvbg",
    generation: 1,
    catalogHash: `sha256:${"a".repeat(64)}`,
    selectionContextHash: "context",
  };
  const state: NativeState = {
    revision: "revision",
    platform: "android",
    appVersion: "1.0.0",
    channel: "production",
    channelKey: "cHJvZHVjdGlvbg",
    runtimeId: "runtime",
    embeddedBundleId: bundleId,
    minimumBundleId: bundleId,
    cohort: "1",
    runningSelection: selection,
    runningConfirmed: true,
    confirmedSelection: selection,
    nextSelection: null,
    crashedBundleIds: [],
    unconfirmedReleaseIds: [],
  };
  const stored = new Map<string, string>();
  const native = {
    getState: (callback: (reply: NativeReply<NativeState>) => void) =>
      callback({ ok: true, data: state }),
    notifyAppReady: (
      callback: (reply: NativeReply<ConfirmationResult>) => void,
    ) => callback({ ok: true, data: confirmation }),
    getPluginInfo: () => ({
      ok: true,
      data: { installId: "installation", isDebugBuild: false },
    }),
    getPluginStorageItem: (key: string) => ({
      ok: true,
      data: stored.get(key) ?? null,
    }),
    setPluginStorageItem: vi.fn((key: string, value: string | null) => {
      if (value === null) stored.delete(key);
      else stored.set(key, value);
      return { ok: true, data: true };
    }),
  };
  vi.stubGlobal("NativeModules", { HotUpdaterLynx: native });
  const { HotUpdater } = await import("./index");
  return { HotUpdater, native, state, stored };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("emits primary readiness once despite concurrent confirmations, with the actual bundle identity", async () => {
  const { HotUpdater, state, stored } = await setup();
  const ready = vi.fn();
  let context!: HotUpdaterClientContext;
  HotUpdater.init({
    baseURL: "https://updates.test",
    plugins: [
      {
        id: "observer",
        setup(value) {
          context = value;
          value.storage.set("user", "alice");
          return { onAppReady: ready };
        },
      },
    ],
  });
  await Promise.all([HotUpdater.notifyAppReady(), HotUpdater.notifyAppReady()]);
  expect(ready).toHaveBeenCalledExactlyOnceWith({
    status: "UNCHANGED",
    channel: "production",
    bundleId,
    releaseId,
  });
  expect(context.getBundleId()).toBe(bundleId);
  expect(context.installId).toBe("installation");
  expect(stored.get("plugins/observer/user")).toBe("alice");
  state.cohort = "17";
  expect(context.getCohort()).toBe("1");
  await HotUpdater.getLaunchInfo();
  expect(context.getCohort()).toBe("17");
});

it.each(["PAGE_ADMITTED", "PAGE_ALREADY_ADMITTED"] as const)(
  "does not report %s as a second app launch",
  async (status) => {
    const { HotUpdater } = await setup({ status, pageAttemptId: "page" });
    const ready = vi.fn();
    HotUpdater.init({
      baseURL: "https://updates.test",
      plugins: [{ id: "observer", setup: () => ({ onAppReady: ready }) }],
    });
    await HotUpdater.notifyAppReady();
    expect(ready).not.toHaveBeenCalled();
  },
);

it("uses the native recovery strategy instead of inferring it from current selection", async () => {
  const from = {
    kind: "BUNDLE" as const,
    bundleId: "failed",
    releaseId: "failed-release",
    channel: "production",
  };
  const to = {
    kind: "BUNDLE" as const,
    bundleId,
    releaseId,
    channel: "production",
  };
  const { HotUpdater } = await setup({
    status: "CONFIRMED",
    transitionId: "transition",
    transition: {
      kind: "RECOVERED",
      from,
      to,
      updateStrategy: "fingerprint",
    },
  });
  const ready = vi.fn();
  HotUpdater.init({
    baseURL: "https://updates.test",
    plugins: [{ id: "observer", setup: () => ({ onAppReady: ready }) }],
  });
  await HotUpdater.notifyAppReady();
  expect(ready).toHaveBeenCalledExactlyOnceWith({
    status: "RECOVERED",
    channel: "production",
    fromBundleId: "failed",
    fromReleaseId: "failed-release",
    toBundleId: bundleId,
    toReleaseId: releaseId,
    updateStrategy: "fingerprint",
  });
});

it("keeps throwing, rejected and never-settling hooks observational", async () => {
  const { HotUpdater } = await setup();
  const onError = vi.fn();
  HotUpdater.init({
    baseURL: "https://updates.test",
    onError,
    plugins: [
      {
        id: "throw",
        setup: () => ({
          onAppReady: () => {
            throw new Error("observer failed");
          },
        }),
      },
      {
        id: "reject",
        setup: () => ({
          onAppReady: async () => {
            throw new Error("async observer failed");
          },
        }),
      },
      {
        id: "pending",
        setup: () => ({ onAppReady: () => new Promise(() => {}) }),
      },
    ],
  });
  await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
    status: "UNCHANGED",
  });
  expect(onError).toHaveBeenCalledTimes(2);
});

it("reports a native storage failure without changing the successful readiness result", async () => {
  const { HotUpdater, native } = await setup();
  native.setPluginStorageItem.mockImplementation(() => {
    throw new Error("disk full");
  });
  const onError = vi.fn();
  HotUpdater.init({
    baseURL: "https://updates.test",
    onError,
    plugins: [
      {
        id: "observer",
        setup: (context) => ({
          onAppReady: () => context.storage.set("key", "value"),
        }),
      },
    ],
  });
  await expect(HotUpdater.notifyAppReady()).resolves.toEqual({
    status: "UNCHANGED",
  });
  expect(onError).toHaveBeenCalledOnce();
});

import {
  defineClientPlugin,
  type HotUpdaterClientContext,
} from "@hot-updater/protocol";
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
    minimumBundleId: "00000000-0000-7000-8000-000000000000",
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
    getStateSync: () => ({ ok: true, data: state }),
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
  const updater = HotUpdater.init({
    baseURL: "https://updates.test",
    plugins: [
      {
        id: "observer",
        setup(value: HotUpdaterClientContext) {
          context = value;
          value.storage.set("user", "alice");
          return { hooks: { onAppReady: ready } };
        },
      },
    ],
  });
  await Promise.all([updater.notifyAppReady(), updater.notifyAppReady()]);
  expect(ready).toHaveBeenCalledExactlyOnceWith({
    status: "UNCHANGED",
    channel: "production",
    bundleId,
    releaseId,
  });
  expect(context.getBundleId()).toBe(bundleId);
  expect(context.installId).toBe("installation");
  expect(context.minBundleId).toBe(state.embeddedBundleId);
  expect(context.minBundleId).not.toBe(state.minimumBundleId);
  expect(stored.get("plugins/observer/user")).toBe("alice");
  state.cohort = "17";
  expect(context.getCohort()).toBe("17");
});

it.each(["PAGE_ADMITTED", "PAGE_ALREADY_ADMITTED"] as const)(
  "does not report %s as a second app launch",
  async (status) => {
    const { HotUpdater } = await setup({ status, pageAttemptId: "page" });
    const ready = vi.fn();
    const updater = HotUpdater.init({
      baseURL: "https://updates.test",
      plugins: [
        { id: "observer", setup: () => ({ hooks: { onAppReady: ready } }) },
      ],
    });
    await updater.notifyAppReady();
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
  const updater = HotUpdater.init({
    baseURL: "https://updates.test",
    plugins: [
      { id: "observer", setup: () => ({ hooks: { onAppReady: ready } }) },
    ],
  });
  await updater.notifyAppReady();
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
  const updater = HotUpdater.init({
    baseURL: "https://updates.test",
    onError,
    plugins: [
      {
        id: "throw",
        setup: () => ({
          hooks: {
            onAppReady: () => {
              throw new Error("observer failed");
            },
          },
        }),
      },
      {
        id: "reject",
        setup: () => ({
          hooks: {
            onAppReady: async () => {
              throw new Error("async observer failed");
            },
          },
        }),
      },
      {
        id: "pending",
        setup: () => ({
          hooks: { onAppReady: () => new Promise<void>(() => {}) },
        }),
      },
    ],
  });
  await expect(updater.notifyAppReady()).resolves.toEqual({
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
  const updater = HotUpdater.init({
    baseURL: "https://updates.test",
    onError,
    plugins: [
      {
        id: "observer",
        setup: (context: HotUpdaterClientContext) => ({
          hooks: { onAppReady: () => context.storage.set("key", "value") },
        }),
      },
    ],
  });
  await expect(updater.notifyAppReady()).resolves.toEqual({
    status: "UNCHANGED",
  });
  expect(onError).toHaveBeenCalledOnce();
});

it("exposes independent plugin APIs immediately, with live native state and immutable request settings", async () => {
  const { HotUpdater, native, state } = await setup();
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response("ok"),
  );
  vi.stubGlobal("fetch", fetch);
  const plugin = defineClientPlugin({
    id: "probe",
    setup(context) {
      let user = "unset";
      return {
        api: {
          setUser(value: string) {
            user = value;
          },
          read: () => ({
            user,
            cohort: context.getCohort(),
            bundle: context.getBundleId(),
          }),
          fetch: () => context.fetch("probe"),
        },
      };
    },
  });
  const headers = { Authorization: "first" };
  const first = HotUpdater.init({
    baseURL: "https://first.test",
    requestHeaders: headers,
    plugins: [plugin],
  });
  const second = HotUpdater.init({
    baseURL: "https://second.test",
    plugins: [plugin],
  });
  first.probe.setUser("alice");
  expect(first.probe.read()).toEqual({
    user: "alice",
    cohort: "1",
    bundle: bundleId,
  });
  expect(second.probe.read().user).toBe("unset");
  expect(Object.isFrozen(first)).toBe(true);
  expect("checkForUpdate" in HotUpdater).toBe(false);
  state.cohort = "17";
  expect(first.probe.read().cohort).toBe("17");
  expect(second.getCohort()).toBe("17");
  headers.Authorization = "changed";
  await first.probe.fetch();
  await second.probe.fetch();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://first.test/probe",
    "https://second.test/probe",
  ]);
  expect(
    new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization"),
  ).toBe("first");
  expect(
    new Headers(fetch.mock.calls[1]![1]?.headers).has("Authorization"),
  ).toBe(false);
  vi.spyOn(native, "getStateSync").mockImplementation(() => {
    throw new Error("GENERATION_RETIRED");
  });
  expect(() => first.probe.read()).toThrow("GENERATION_RETIRED");
  expect(() => second.getCohort()).toThrow("GENERATION_RETIRED");
});

it("rejects reserved and duplicate plugin ids before setup can replace SDK methods", async () => {
  const { HotUpdater } = await setup();
  const setupPlugin = vi.fn(() => ({ api: {} }));
  expect(() =>
    HotUpdater.init({
      baseURL: "https://updates.test",
      plugins: [{ id: "reload", setup: setupPlugin }],
    }),
  ).toThrow('cannot use the id "reload"');
  expect(() =>
    HotUpdater.init({
      baseURL: "https://updates.test",
      plugins: [
        { id: "same", setup: setupPlugin },
        { id: "same", setup: setupPlugin },
      ],
    }),
  ).toThrow('Two plugins use the id "same"');
  expect(setupPlugin).not.toHaveBeenCalled();
});

it("keeps endpoint resolution lazy for offline readiness and fails an update without starting HTTP", async () => {
  const { HotUpdater } = await setup();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const resolve = vi.fn(() => {
    throw new Error("Endpoint is not configured");
  });
  const updater = HotUpdater.init({ baseURL: resolve });
  await expect(updater.notifyAppReady()).resolves.toEqual({
    status: "UNCHANGED",
  });
  expect(resolve).not.toHaveBeenCalled();
  await expect(
    updater.checkForUpdate({ updateStrategy: "appVersion" }),
  ).rejects.toThrow("Endpoint is not configured");
  expect(resolve).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

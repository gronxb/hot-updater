import { afterEach, expect, it, vi } from "vitest";

import { createE2eUpdater } from "./insights";
import { describeRemoteConfig, runRemoteConfigAction } from "./remoteConfig";

afterEach(() => vi.unstubAllGlobals());

it("fetches with live Lynx context, activates explicitly and restores only activated values", async () => {
  const stored = new Map<string, string>();
  const state = {
    platform: "android",
    appVersion: "1.0.0",
    channel: "production",
    cohort: "1",
    fingerprintHash: "native-fingerprint",
    embeddedBundleId: "00000000-0000-7000-8000-000000000001",
    runningSelection: { bundleId: "00000000-0000-7000-8000-000000000002" },
  };
  const notifyAppReady = vi.fn();
  vi.stubGlobal("NativeModules", {
    HotUpdaterLynx: {
      getStateSync: () => ({ ok: true, data: state }),
      getPluginInfo: () => ({
        ok: true,
        data: { installId: "lynx-installation", isDebugBuild: true },
      }),
      getPluginStorageItem: (key: string) => ({
        ok: true,
        data: stored.get(key) ?? null,
      }),
      setPluginStorageItem: (key: string, value: string | null) => {
        if (value === null) stored.delete(key);
        else stored.set(key, value);
        return { ok: true, data: true };
      },
      notifyAppReady,
    },
  });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      version: 1,
      values: { e2e_message: "qa value", e2e_limit: "7" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const updater = createE2eUpdater("https://updates.test/hot-updater");
  const defaults =
    "message=in-app default(default) limit=1(default) flag=true(default)";
  const active = "message=qa value(remote) limit=7(remote) flag=true(default)";
  expect(describeRemoteConfig(updater.remoteConfig)).toBe(defaults);
  expect(fetch).not.toHaveBeenCalled();

  // A different page can change the native cohort after this client was set up.
  state.cohort = "qa";
  expect(await runRemoteConfigAction(updater.remoteConfig, "fetch")).toBe(
    "remote-config fetch -> success",
  );
  const request = new URL(fetch.mock.calls[0]![0]);
  expect(request.pathname).toBe("/hot-updater/remote-config");
  expect(Object.fromEntries(request.searchParams)).toEqual({
    platform: "android",
    appVersion: "1.0.0",
    channel: "production",
    cohort: "qa",
    fingerprintHash: "native-fingerprint",
  });
  expect(describeRemoteConfig(updater.remoteConfig)).toBe(defaults);
  expect(
    describeRemoteConfig(
      createE2eUpdater("https://updates.test/hot-updater").remoteConfig,
    ),
  ).toBe(defaults);
  expect(await runRemoteConfigAction(updater.remoteConfig, "activate")).toBe(
    "remote-config activate -> true",
  );
  expect(describeRemoteConfig(updater.remoteConfig)).toBe(active);
  const relaunched = createE2eUpdater("https://updates.test/hot-updater");
  expect(describeRemoteConfig(relaunched.remoteConfig)).toBe(active);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await runRemoteConfigAction(relaunched.remoteConfig, "activate")).toBe(
    "remote-config activate -> false",
  );

  fetch.mockResolvedValueOnce(
    Response.json({
      version: 2,
      values: { e2e_message: "next", e2e_limit: "9", e2e_flag: "false" },
    }),
  );
  expect(
    await runRemoteConfigAction(relaunched.remoteConfig, "fetchAndActivate"),
  ).toBe("remote-config fetchAndActivate -> true");
  const updated = describeRemoteConfig(relaunched.remoteConfig);
  expect(updated).toBe(
    "message=next(remote) limit=9(remote) flag=false(remote)",
  );
  fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  expect(
    await runRemoteConfigAction(relaunched.remoteConfig, "fetchAndActivate"),
  ).toContain("remote-config fetchAndActivate -> error");
  expect(describeRemoteConfig(relaunched.remoteConfig)).toBe(updated);
  expect(notifyAppReady).not.toHaveBeenCalled();
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AppReadyResult,
  defineClientPlugin,
  type HotUpdaterClientContext,
  type UpdateError,
} from "./clientPlugin";
import {
  createTestStorage,
  setupClientPlugin,
  setupClientPlugins,
} from "./testing";

const launch: AppReadyResult = {
  status: "UNCHANGED",
  channel: "production",
  bundleId: "bundle-a",
  releaseId: "release-a",
  previousProcessExit: null,
};

const failure: UpdateError = {
  stage: "download",
  reason: "network",
  targetBundleId: "bundle-b",
  channel: "production",
  bundleId: "bundle-a",
  releaseId: "release-a",
  updateStrategy: "appVersion",
  cause: new Error("offline"),
};

/** Posts each launch to `/events` and stores the response status. */
const reporter = (id = "reporter") =>
  defineClientPlugin({
    id,
    setup(context) {
      return {
        async onAppReady(result) {
          const response = await context.fetch("events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: result.status,
              installId: context.installId,
            }),
          });
          context.storage.set("lastStatus", String(response.status));
        },
      };
    },
  });

/** Hands its context to the test. */
const contextOf = (options?: Parameters<typeof setupClientPlugin>[1]) => {
  let captured: HotUpdaterClientContext | undefined;
  setupClientPlugin(
    defineClientPlugin({
      id: "probe",
      setup(context) {
        captured = context;
      },
    }),
    options,
  );
  return captured!;
};

describe("setupClientPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the plugin a context with fixed defaults", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 30) });
    const context = contextOf();

    expect({
      installId: context.installId,
      platform: context.platform,
      appVersion: context.appVersion,
      sdkVersion: context.sdkVersion,
      isDebugBuild: context.isDebugBuild,
      bundleId: context.getBundleId(),
      channel: context.getChannel(),
      cohort: context.getCohort(),
      fingerprintHash: context.getFingerprintHash(),
      now: context.now(),
    }).toEqual({
      installId: "00000000-0000-4000-8000-000000000000",
      platform: "ios",
      appVersion: "1.0.0",
      sdkVersion: "0.0.0-test",
      isDebugBuild: false,
      bundleId: "00000000-0000-0000-0000-000000000000",
      channel: "production",
      cohort: "1",
      fingerprintHash: null,
      now: Date.UTC(2026, 8, 30),
    });
  });

  it("takes the device's values as values or as getters read on each call", () => {
    let channel = "beta";
    const context = contextOf({
      installId: "install-1",
      platform: "android",
      appVersion: null,
      sdkVersion: "1.2.3",
      isDebugBuild: true,
      bundleId: "bundle-b",
      channel: () => channel,
      cohort: "42",
      fingerprintHash: "fingerprint-1",
      now: () => 1_000,
    });

    channel = "production";

    expect(context.installId).toBe("install-1");
    expect(context.platform).toBe("android");
    expect(context.appVersion).toBeNull();
    expect(context.sdkVersion).toBe("1.2.3");
    expect(context.isDebugBuild).toBe(true);
    expect(context.getBundleId()).toBe("bundle-b");
    expect(context.getChannel()).toBe("production");
    expect(context.getCohort()).toBe("42");
    expect(context.getFingerprintHash()).toBe("fingerprint-1");
    expect(context.now()).toBe(1_000);
  });

  it("records what a hook sends, with the SDK's request headers, and answers it", async () => {
    const runtime = setupClientPlugin(reporter(), {
      baseURL: "https://updates.example.com/hot-updater/",
      requestHeaders: {
        "x-api-key": "client-key",
        "content-type": "text/plain",
      },
      installId: "install-1",
      respond: () => new Response(null, { status: 202 }),
    });

    runtime.hooks.onAppReady(launch);
    await runtime.settled();

    expect(runtime.requests).toHaveLength(1);
    const [request] = runtime.requests;
    expect(request).toMatchObject({
      url: "https://updates.example.com/hot-updater/events",
      path: "/events",
      method: "POST",
      // The plugin's own header wins over requestHeaders, as in the app.
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
      },
    });
    expect(request?.json()).toEqual({
      status: "UNCHANGED",
      installId: "install-1",
    });
    expect(runtime.storage.get("reporter", "lastStatus")).toBe("202");
    expect(runtime.errors).toEqual([]);
  });

  it("answers 204 without a handler", async () => {
    const runtime = setupClientPlugin(reporter());

    runtime.hooks.onAppReady(launch);
    await runtime.settled();

    expect(runtime.requests.map(({ url }) => url)).toEqual([
      "https://hot-updater.example.com/events",
    ]);
    expect(runtime.storage.get("reporter", "lastStatus")).toBe("204");
  });

  it("fails requests the way the SDK's fetch does", async () => {
    const outcomes: string[] = [];
    const attempt = async (context: HotUpdaterClientContext, path: string) => {
      try {
        await context.fetch(path);
        outcomes.push(`${path}: ok`);
      } catch (error) {
        outcomes.push(`${path}: ${(error as Error).message}`);
      }
    };
    const runtime = setupClientPlugin(
      defineClientPlugin({
        id: "fetcher",
        setup: (context) => ({
          onAppReady: () =>
            Promise.all([
              attempt(context, "offline"),
              attempt(context, "slow"),
              attempt(context, "https://elsewhere.example.com/x"),
            ]).then(() => undefined),
        }),
      }),
      {
        requestTimeout: 20,
        respond: (request) => {
          if (request.path === "/offline") {
            throw new TypeError("Network request failed");
          }
          return new Promise<Response>(() => {});
        },
      },
    );

    runtime.hooks.onAppReady(launch);
    await runtime.settled();

    expect(outcomes.toSorted()).toEqual([
      "https://elsewhere.example.com/x: [HotUpdater] Plugin fetch takes a path relative to baseURL.",
      "offline: Network request failed",
      "slow: Request timed out",
    ]);
    expect(runtime.requests.map(({ path }) => path).toSorted()).toEqual([
      "/offline",
      "/slow",
    ]);
  });

  it("calls hooks without waiting for them and reports their failures", async () => {
    let slowHookDone = false;
    const calls: string[] = [];
    const runtime = setupClientPlugins([
      defineClientPlugin({
        id: "failing",
        setup: () => ({
          onAppReady() {
            throw new Error("sync failure");
          },
          async onUpdateError() {
            throw new Error("async failure");
          },
          async onBundleDownloaded() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            slowHookDone = true;
          },
        }),
      }),
      defineClientPlugin({
        id: "observer",
        setup: () => ({
          onAppReady: (result) => {
            calls.push(result.status);
          },
        }),
      }),
    ]);

    expect(runtime.hooks.onAppReady(launch)).toBeUndefined();
    runtime.hooks.onUpdateError(failure);
    runtime.hooks.onBundleDownloaded({
      channel: "production",
      fromBundleId: "bundle-a",
      fromReleaseId: "release-a",
      toBundleId: "bundle-b",
      toReleaseId: "release-b",
      updateStrategy: "appVersion",
      delivery: "manifest",
      patchFallback: false,
    });
    // A throw in one plugin's hook doesn't stop the next plugin's.
    expect(calls).toEqual(["UNCHANGED"]);
    expect(slowHookDone).toBe(false);

    await runtime.settled();

    expect(slowHookDone).toBe(true);
    expect(
      runtime.errors.map((error) => [
        error.message,
        (error.cause as Error).message,
      ]),
    ).toEqual([
      ['[HotUpdater] Plugin "failing" failed in onAppReady', "sync failure"],
      [
        '[HotUpdater] Plugin "failing" failed in onUpdateError',
        "async failure",
      ],
    ]);
  });

  it("reports a setup that throws and leaves that plugin without hooks", () => {
    const runtime = setupClientPlugin(
      defineClientPlugin({
        id: "broken",
        setup() {
          throw new Error("no config");
        },
      }),
    );

    expect(runtime.listens("onAppReady")).toBe(false);
    expect(runtime.errors.map(({ message }) => message)).toEqual([
      '[HotUpdater] Plugin "broken" failed in setup',
    ]);
  });

  it("tells which hooks the plugins returned", () => {
    const runtime = setupClientPlugin(reporter());

    expect(runtime.listens("onAppReady")).toBe(true);
    expect(runtime.listens("onUpdateCheck")).toBe(false);
  });

  it("rejects plugin ids the SDK rejects", () => {
    expect(() => setupClientPlugins([reporter("a"), reporter("a")])).toThrow(
      '[HotUpdater] Two plugins use the id "a". Plugin ids must be unique.',
    );
    expect(() => setupClientPlugin(reporter(""))).toThrow(
      "[HotUpdater] A plugin id must be a non-empty string.",
    );
  });

  it("sets a plugin up once per runtime", () => {
    const setup = vi.fn(() => ({ onAppReady: () => {} }));
    const plugin = defineClientPlugin({ id: "counted", setup });

    const runtime = setupClientPlugin(plugin);
    runtime.hooks.onAppReady(launch);
    runtime.hooks.onAppReady(launch);
    setupClientPlugin(plugin);

    expect(setup).toHaveBeenCalledTimes(2);
  });
});

describe("plugin storage", () => {
  const keeper = (id: string) =>
    defineClientPlugin({
      id,
      setup(context) {
        return {
          onAppReady: () => {
            const launches = Number(context.storage.get("launches") ?? "0");
            context.storage.set("launches", String(launches + 1));
          },
        };
      },
    });

  it("keeps each plugin's keys apart", () => {
    const runtime = setupClientPlugins([keeper("a"), keeper("b/c")]);

    runtime.hooks.onAppReady(launch);
    runtime.hooks.onAppReady(launch);

    expect(runtime.storage.entries("a")).toEqual({ launches: "2" });
    expect(runtime.storage.entries("b/c")).toEqual({ launches: "2" });
    expect(runtime.storage.entries("b")).toEqual({});
  });

  it("outlives a runtime, as a relaunch on the same device", () => {
    const storage = createTestStorage();
    storage.set("a", "launches", "5");

    setupClientPlugin(keeper("a"), { storage }).hooks.onAppReady(launch);
    const relaunch = setupClientPlugin(keeper("a"), { storage });
    relaunch.hooks.onAppReady(launch);

    expect(relaunch.storage).toBe(storage);
    expect(storage.get("a", "launches")).toBe("7");
  });

  it("caps values at 64 KB, as native storage does", () => {
    const runtime = setupClientPlugin(
      defineClientPlugin({
        id: "large",
        setup: (context) => ({
          onAppReady: () => {
            context.storage.set("value", "x".repeat(64 * 1024 + 1));
          },
        }),
      }),
    );

    runtime.hooks.onAppReady(launch);

    expect(
      runtime.errors.map((error) => (error.cause as Error).message),
    ).toEqual(["[HotUpdater] Plugin storage values are at most 64 KB."]);
    expect(runtime.storage.entries("large")).toEqual({});
  });

  it("takes only storage it created", () => {
    expect(() =>
      setupClientPlugin(keeper("a"), {
        storage: { get: () => null, set: () => {}, entries: () => ({}) },
      }),
    ).toThrow(
      "[HotUpdater] Pass a storage from createTestStorage() or an earlier runtime.",
    );
  });
});

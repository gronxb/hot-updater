import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterClientContext,
  HotUpdaterClientPlugin,
} from "./clientPlugin";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  return {
    getAppVersion: vi.fn<() => string | null>(() => "1.2.3"),
    getBundleId: vi.fn(() => "bundle-id"),
    getChannel: vi.fn(() => "production"),
    getCohort: vi.fn(() => "123"),
    getFingerprintHash: vi.fn<() => string | null>(() => null),
    getInstallId: vi.fn(() => "install-id"),
    getMinBundleId: vi.fn(() => "min-bundle-id"),
    getStorageItem: vi.fn<(key: string) => string | null>(() => null),
    setStorageItem: vi.fn<(key: string, value: string | null) => void>(),
  };
});

vi.mock("./native", () => mocks);

const importHost = () => import("./pluginHost");

const capture = (id = "example") => {
  let context!: HotUpdaterClientContext;
  const setup = vi.fn((pluginContext: HotUpdaterClientContext) => {
    context = pluginContext;
  });
  const plugin: HotUpdaterClientPlugin = { id, setup };
  return { plugin, setup, context: () => context };
};

describe("client plugin host", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.getStorageItem.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws at configuration for two plugins with one id", async () => {
    const { configurePlugins } = await importHost();

    expect(() =>
      configurePlugins([capture("same").plugin, capture("same").plugin], {
        baseURL: "https://updates.example.com",
      }),
    ).toThrow('Two plugins use the id "same"');
  });

  it("sets a plugin up once and stops calling a plugin left out", async () => {
    const { configurePlugins, emitPluginHook } = await importHost();
    const onAppReady = vi.fn();
    const plugin: HotUpdaterClientPlugin = {
      id: "example",
      setup: vi.fn(() => ({ hooks: { onAppReady } })),
    };
    const config = { baseURL: "https://updates.example.com" };

    configurePlugins([plugin], config);
    configurePlugins([plugin], config);
    emitPluginHook("onAppReady", () => ({
      status: "UNCHANGED",
      channel: "production",
      bundleId: "bundle-id",
      releaseId: null,
    }));
    configurePlugins([], config);
    emitPluginHook("onAppReady", () => ({
      status: "UNCHANGED",
      channel: "production",
      bundleId: "bundle-id",
      releaseId: null,
    }));

    expect(plugin.setup).toHaveBeenCalledOnce();
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("returns each plugin's API by id, the same one when configured again", async () => {
    const { configurePlugins } = await importHost();
    const api = { read: () => "value" };
    const withApi: HotUpdaterClientPlugin = {
      id: "withApi",
      setup: vi.fn(() => ({ api })),
    };
    const config = { baseURL: "https://updates.example.com" };

    const first = configurePlugins(
      [withApi, capture("hooksOnly").plugin],
      config,
    );
    const second = configurePlugins([withApi], config);

    expect(first).toEqual({ withApi: api });
    expect(second.withApi).toBe(api);
    expect(Object.isFrozen(first)).toBe(true);
    expect(withApi.setup).toHaveBeenCalledOnce();
  });

  it("reports a setup that returns its hooks without { hooks }", async () => {
    const onError = vi.fn();
    const { configurePlugins } = await importHost();
    const plugin = {
      id: "legacy",
      setup: () => ({ onAppReady: () => {} }),
    } as unknown as HotUpdaterClientPlugin;

    configurePlugins([plugin], {
      baseURL: "https://updates.example.com",
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          '[HotUpdater] Plugin "legacy" setup returned "onAppReady"; setup returns { hooks, api }',
      }),
    );
  });

  it("warns without onError when setup throws, and keeps other plugins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { configurePlugins } = await importHost();
    const healthy = capture("healthy");

    configurePlugins(
      [
        {
          id: "broken",
          setup: () => {
            throw new Error("setup failed");
          },
        },
        healthy.plugin,
      ],
      { baseURL: "https://updates.example.com" },
    );

    expect(healthy.setup).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[HotUpdater] Plugin "broken" failed in setup',
      expect.objectContaining({ message: "setup failed" }),
    );
  });

  it("never waits for a hook", async () => {
    const { configurePlugins, emitPluginHook } = await importHost();
    const onUpdateCheck = vi.fn(() => new Promise<void>(() => {}));
    configurePlugins(
      [{ id: "slow", setup: () => ({ hooks: { onUpdateCheck } }) }],
      { baseURL: "https://updates.example.com" },
    );

    const result = emitPluginHook("onUpdateCheck", () => ({
      status: "UNCHANGED",
      channel: "production",
      bundleId: "bundle-id",
      releaseId: null,
      previousReleaseId: null,
    }));

    expect(result).toBeUndefined();
    expect(onUpdateCheck).toHaveBeenCalledOnce();
  });

  it("builds an event only when a plugin listens", async () => {
    const { configurePlugins, emitPluginHook } = await importHost();
    configurePlugins([capture().plugin], {
      baseURL: "https://updates.example.com",
    });
    const createPayload = vi.fn(() => null);

    emitPluginHook("onUpdateError", createPayload);

    expect(createPayload).not.toHaveBeenCalled();
  });

  it("exposes the app's identity and environment", async () => {
    vi.stubGlobal("__DEV__", true);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { configurePlugins } = await importHost();
    const plugin = capture();
    configurePlugins([plugin.plugin], {
      baseURL: "https://updates.example.com",
    });
    const context = plugin.context();

    expect({
      appVersion: context.appVersion,
      bundleId: context.getBundleId(),
      channel: context.getChannel(),
      cohort: context.getCohort(),
      fingerprintHash: context.getFingerprintHash(),
      installId: context.installId,
      isDebugBuild: context.isDebugBuild,
      minBundleId: context.minBundleId,
      now: context.now(),
      platform: context.platform,
      sdkVersion: context.sdkVersion,
    }).toEqual({
      appVersion: "1.2.3",
      bundleId: "bundle-id",
      channel: "production",
      cohort: "123",
      fingerprintHash: null,
      installId: "install-id",
      isDebugBuild: true,
      minBundleId: "min-bundle-id",
      now: 1_700_000_000_000,
      platform: "android",
      sdkVersion: "test-sdk-version",
    });
  });

  describe("fetch", () => {
    it("requests a path under the resolved baseURL with the SDK's headers", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 204 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { configurePlugins } = await importHost();
      const plugin = capture();
      configurePlugins([plugin.plugin], {
        baseURL: async () => "https://updates.example.com/hot-updater/",
        requestHeaders: { "x-api-key": "client-key", "X-Shared": "sdk" },
      });

      await plugin.context().fetch("/events", {
        headers: { "Content-Type": "application/json", "X-Shared": "plugin" },
        method: "POST",
      });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://updates.example.com/hot-updater/events");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("client-key");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-shared")).toBe("plugin");
    });

    it("rejects with Request timed out after the SDK's timeout", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                );
              });
            }),
        ),
      );
      const { configurePlugins } = await importHost();
      const plugin = capture();
      configurePlugins([plugin.plugin], {
        baseURL: "https://updates.example.com",
        requestTimeout: 2_000,
      });

      const request = plugin.context().fetch("events");
      const settled = expect(request).rejects.toThrow("Request timed out");
      await vi.advanceTimersByTimeAsync(2_000);
      await settled;
    });

    it("rejects with Request timed out when Expo's fetch cancels on the timeout", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(
                  new Error(
                    "fetch failed: FetchRequestCanceledException: Fetch request has been canceled",
                  ),
                );
              });
            }),
        ),
      );
      const { configurePlugins } = await importHost();
      const plugin = capture();
      configurePlugins([plugin.plugin], {
        baseURL: "https://updates.example.com",
        requestTimeout: 2_000,
      });

      const request = plugin.context().fetch("events");
      const settled = expect(request).rejects.toThrow("Request timed out");
      await vi.advanceTimersByTimeAsync(2_000);
      await settled;
    });

    it("refuses a URL outside baseURL", async () => {
      const { configurePlugins } = await importHost();
      const plugin = capture();
      configurePlugins([plugin.plugin], {
        baseURL: "https://updates.example.com",
      });

      await expect(
        plugin.context().fetch("https://elsewhere.example.com/events"),
      ).rejects.toThrow("relative to baseURL");
    });
  });

  describe("storage", () => {
    it("scopes keys to the plugin and reads its own writes", async () => {
      mocks.getStorageItem.mockReturnValue("from-native");
      const { configurePlugins } = await importHost();
      const plugin = capture("example");
      configurePlugins([plugin.plugin], {
        baseURL: "https://updates.example.com",
      });
      const { storage } = plugin.context();

      expect(storage.get("state")).toBe("from-native");
      expect(storage.get("state")).toBe("from-native");
      storage.set("state", "next");
      expect(storage.get("state")).toBe("next");
      storage.set("state", null);
      expect(storage.get("state")).toBeNull();

      expect(mocks.getStorageItem).toHaveBeenCalledOnce();
      expect(mocks.getStorageItem).toHaveBeenCalledWith(
        "plugins/example/state",
      );
      expect(mocks.setStorageItem.mock.calls).toEqual([
        ["plugins/example/state", "next"],
        ["plugins/example/state", null],
      ]);
    });

    it("refuses empty keys, non-string values, and values over 64 KB", async () => {
      const { configurePlugins } = await importHost();
      const plugin = capture();
      configurePlugins([plugin.plugin], {
        baseURL: "https://updates.example.com",
      });
      const { storage } = plugin.context();

      expect(() => storage.get("")).toThrow("non-empty strings");
      expect(() => storage.set("key", 1 as unknown as string)).toThrow(
        "strings or null",
      );
      expect(() => storage.set("key", "x".repeat(64 * 1024 + 1))).toThrow(
        "at most 64 KB",
      );
      expect(mocks.setStorageItem).not.toHaveBeenCalled();
    });
  });
});

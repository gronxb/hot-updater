import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdater as HotUpdaterValue } from "./index";
import type { HotUpdaterInitOptions, HotUpdaterOptions } from "./wrap";

const mocks = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };

  return {
    addListener: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(),
    clearCrashHistory: vi.fn(() => true),
    createDefaultResolver: vi.fn(),
    getAppVersion: vi.fn(() => "1.0.0"),
    getBaseURL: vi.fn(() => null),
    getBundleId: vi.fn(() => "bundle-id"),
    getChannel: vi.fn(() => "production"),
    getCohort: vi.fn(() => "123"),
    getCrashHistory: vi.fn(() => []),
    getDefaultChannel: vi.fn(() => "production"),
    getFingerprintHash: vi.fn(() => null),
    getInstallId: vi.fn(() => "install-id"),
    getManifest: vi.fn(() => null),
    getMinBundleId: vi.fn(() => "min-bundle-id"),
    init: vi.fn(),
    isChannelSwitched: vi.fn(() => false),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setCohort: vi.fn(),
    setReloadBehavior: vi.fn(),
    updateBundle: vi.fn(),
    wrap: vi.fn(),
  };
});

vi.mock("./DefaultResolver", () => ({
  createDefaultResolver: mocks.createDefaultResolver,
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  clearCrashHistory: mocks.clearCrashHistory,
  getAppVersion: mocks.getAppVersion,
  getBaseURL: mocks.getBaseURL,
  getBundleId: mocks.getBundleId,
  getChannel: mocks.getChannel,
  getCohort: mocks.getCohort,
  getCrashHistory: mocks.getCrashHistory,
  getDefaultChannel: mocks.getDefaultChannel,
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  getManifest: mocks.getManifest,
  getMinBundleId: mocks.getMinBundleId,
  isChannelSwitched: mocks.isChannelSwitched,
  reload: mocks.reload,
  resetChannel: mocks.resetChannel,
  setCohort: mocks.setCohort,
  setReloadBehavior: mocks.setReloadBehavior,
  updateBundle: mocks.updateBundle,
}));

vi.mock("./wrap", () => ({
  init: mocks.init,
  wrap: mocks.wrap,
}));

const importHotUpdater = async () => {
  const { HotUpdater } = await import("./index");
  return HotUpdater;
};

describe("HotUpdater client initialization", () => {
  beforeEach(() => {
    vi.resetModules();

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.addListener.mockReturnValue(() => {});
    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.createDefaultResolver.mockImplementation((baseURL: unknown) => ({
      baseURL,
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    }));
    mocks.getBaseURL.mockReturnValue(null);
    mocks.init.mockReturnValue(undefined);
    mocks.wrap.mockReturnValue((Component: unknown) => Component);
  });

  it("initializes manual update flows without wrapping a component", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    const result = HotUpdater.init({
      baseURL: "https://updates.example.com",
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
    });

    expect(result).toBeUndefined();
    expect(mocks.createDefaultResolver).toHaveBeenCalledWith(
      "https://updates.example.com",
    );
    expect(mocks.init).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
      resolver,
    });
  });

  it("composes analytics telemetry key into baseURL init app-ready telemetry", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-26T12:00:00.000Z"),
    });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const resolver = {
      checkUpdate: vi.fn(),
    };
    mocks.createDefaultResolver.mockReturnValue(resolver);
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      analytics: {
        telemetryKey: "hutk_publishable",
      },
      baseURL: "https://runtime.example.com/p/prj_123/",
      requestTimeout: 1000,
    });

    const normalizedOptions = mocks.init.mock.calls[0]?.[0];
    expect(normalizedOptions?.resolver.checkUpdate).toBe(resolver.checkUpdate);
    expect(normalizedOptions?.resolver.notifyAppReady).toBeTypeOf("function");

    await normalizedOptions?.resolver.notifyAppReady?.({
      bundleId: "bundle-id",
      channel: "production",
      eventId: "event-id",
      installId: "install-id",
      platform: "ios",
      requestTimeout: 1000,
      status: "STABLE",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.example.com/p/prj_123/api/notify-app-ready",
      {
        body: JSON.stringify({
          bundleId: "bundle-id",
          channel: "production",
          eventId: "event-id",
          installId: "install-id",
          observedAt: "2026-06-26T12:00:00.000Z",
          platform: "ios",
          status: "ACTIVE",
        }),
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": "test-sdk-version",
          "x-hot-updater-telemetry-key": "hutk_publishable",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects malformed analytics telemetry keys before init starts", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() =>
      HotUpdater.init({
        analytics: {
          telemetryKey: "not_publishable",
        },
        baseURL: "https://runtime.example.com/p/prj_123",
      }),
    ).toThrow("telemetryKey must start with hutk_");
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("does not override explicit custom resolver notifyAppReady with analytics", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      analytics: {
        telemetryKey: "hutk_publishable",
      },
      resolver,
    });

    expect(mocks.createDefaultResolver).not.toHaveBeenCalled();
    expect(mocks.init).toHaveBeenCalledWith({
      resolver,
    });
  });

  it("composes analytics notifyAppReady for a custom resolver without one", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-26T12:00:00.000Z"),
    });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const resolver = {
      checkUpdate: vi.fn(),
    };
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      analytics: {
        telemetryKey: "hutk_publishable",
      },
      baseURL: "https://runtime.example.com/p/prj_123/",
      resolver,
    });

    const normalizedOptions = mocks.init.mock.calls[0]?.[0];
    expect(mocks.createDefaultResolver).toHaveBeenCalledWith(
      "https://runtime.example.com/p/prj_123/",
    );
    expect(normalizedOptions?.resolver.checkUpdate).toBe(resolver.checkUpdate);
    expect(normalizedOptions?.resolver.notifyAppReady).toBeTypeOf("function");

    await normalizedOptions?.resolver.notifyAppReady?.({
      bundleId: "bundle-id",
      channel: "production",
      eventId: "event-id",
      installId: "install-id",
      platform: "ios",
      requestTimeout: 1000,
      status: "STABLE",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.example.com/p/prj_123/api/notify-app-ready",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": "test-sdk-version",
          "x-hot-updater-telemetry-key": "hutk_publishable",
        },
        method: "POST",
      }),
    );
  });

  it("accepts dynamic baseURL resolvers for manual update flows", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    const resolveBaseURL = vi.fn(() => "https://updates.example.com");
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: resolveBaseURL,
    });

    expect(mocks.createDefaultResolver).toHaveBeenCalledWith(resolveBaseURL);
    expect(mocks.init).toHaveBeenCalledWith({
      resolver,
    });
  });

  it("accepts custom resolvers for manual update flows", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };

    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      resolver,
      requestHeaders: {
        Authorization: "Bearer token",
      },
    });

    expect(mocks.createDefaultResolver).not.toHaveBeenCalled();
    expect(mocks.init).toHaveBeenCalledWith({
      resolver,
      requestHeaders: {
        Authorization: "Bearer token",
      },
    });
  });

  it("accepts onError during init and uses it for later manual update checks", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    const onError = vi.fn();
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      onError,
    });

    await HotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });

    expect(mocks.init).toHaveBeenCalledWith({
      onError,
      resolver,
    });
    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      onError,
      requestHeaders: {},
      requestTimeout: undefined,
      resolver,
      updateStrategy: "appVersion",
    });
  });

  it("lets checkForUpdate override the init onError handler", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    const initOnError = vi.fn();
    const checkOnError = vi.fn();
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      onError: initOnError,
    });

    await HotUpdater.checkForUpdate({
      onError: checkOnError,
      updateStrategy: "appVersion",
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      onError: checkOnError,
      requestHeaders: {},
      requestTimeout: undefined,
      resolver,
      updateStrategy: "appVersion",
    });
  });

  it("defaults wrap to automatic update mode", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.wrap({
      baseURL: "https://updates.example.com",
      updateStrategy: "appVersion",
    });

    expect(mocks.wrap).toHaveBeenCalledWith({
      resolver,
      updateMode: "auto",
      updateStrategy: "appVersion",
    });
  });

  it("keeps deprecated manual wrap calls working", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.wrap({
      baseURL: "https://updates.example.com",
      updateMode: "manual",
    });

    expect(mocks.wrap).toHaveBeenCalledWith({
      resolver,
      updateMode: "manual",
    });
  });

  it("types public wrap to accept pre-typed option unions", () => {
    const compileOnly = (
      wrap: typeof HotUpdaterValue.wrap,
      options: HotUpdaterOptions,
    ) => wrap(options);

    expect(compileOnly).toBeTypeOf("function");
  });

  it("types public init options with onError", () => {
    const options = {
      analytics: {
        telemetryKey: "hutk_publishable",
      },
      baseURL: "https://updates.example.com",
      onError: vi.fn(),
    } satisfies HotUpdaterInitOptions;

    expect(options.baseURL).toBe("https://updates.example.com");
  });

  it("uses init configuration for later manual update checks", async () => {
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn(),
    };
    mocks.createDefaultResolver.mockReturnValue(resolver);

    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
    });

    await HotUpdater.checkForUpdate({
      requestHeaders: {
        "X-Runtime": "secondary",
      },
      updateStrategy: "appVersion",
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer token",
        "X-Runtime": "secondary",
      },
      requestTimeout: 1000,
      resolver,
      updateStrategy: "appVersion",
    });
  });

  it("points users to wrap or init when methods are called too early", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() =>
      HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
      }),
    ).toThrow("requires HotUpdater.wrap() or HotUpdater.init() to be used");
  });

  it("requires baseURL for init", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() => HotUpdater.init({} as never)).toThrow(
      "Either baseURL or resolver must be provided",
    );
    expect(mocks.init).not.toHaveBeenCalled();
  });
});

import type { UpdateHttpResponse } from "@hot-updater/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterInitOptions } from "./init.types";

const mocks = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };

  return {
    addListener: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(async () => null),
    clearCrashHistory: vi.fn(() => true),
    createHttpClient: vi.fn(
      (
        baseURL: unknown,
        _onResponse?: (response: UpdateHttpResponse) => void,
      ) => ({ baseURL }),
    ),
    getActiveUpdateState: vi.fn(() => ({
      activeSelection: null,
      highestSeenCatalogs: {},
      stableSelection: null,
      verificationPending: false,
    })),
    getAppVersion: vi.fn(() => "1.0.0"),
    getBaseURL: vi.fn(() => null),
    getUpdateId: vi.fn(() => "release-id"),
    getChannel: vi.fn(() => "production"),
    getCohort: vi.fn(() => "123"),
    getCrashHistory: vi.fn(() => []),
    getDefaultChannel: vi.fn(() => "production"),
    getFingerprintHash: vi.fn(() => null),
    getInstallId: vi.fn(() => "install-id"),
    getManifest: vi.fn(() => null),
    getMinBundleId: vi.fn(() => "min-bundle-id"),
    configurePlugins: vi.fn(),
    createAppPluginHost: vi.fn(),
    createLaunchReporter: vi.fn(),
    emit: vi.fn(),
    readLaunch: vi.fn(),
    reportUpdateError: vi.fn(),
    isChannelSwitched: vi.fn(() => false),
    notifyAppReady: vi.fn(() => ({ status: "UNCHANGED" as const })),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setCohort: vi.fn(),
    setReloadBehavior: vi.fn(),
    stageBundle: vi.fn(),
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("./httpClient", () => ({
  createHttpClient: mocks.createHttpClient,
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
  reportUpdateError: mocks.reportUpdateError,
}));

vi.mock("./pluginHost", () => ({
  createAppPluginHost: mocks.createAppPluginHost,
}));

vi.mock("./appReady", () => ({
  createLaunchReporter: mocks.createLaunchReporter,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  clearCrashHistory: mocks.clearCrashHistory,
  getPublicActiveUpdateState: mocks.getActiveUpdateState,
  getActiveUpdateState: mocks.getActiveUpdateState,
  getBundleId: () => "bundle-id",
  getAppVersion: mocks.getAppVersion,
  getBaseURL: mocks.getBaseURL,
  getUpdateId: mocks.getUpdateId,
  getChannel: mocks.getChannel,
  getCohort: mocks.getCohort,
  getCrashHistory: mocks.getCrashHistory,
  getDefaultChannel: mocks.getDefaultChannel,
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  getManifest: mocks.getManifest,
  getMinBundleId: mocks.getMinBundleId,
  isChannelSwitched: mocks.isChannelSwitched,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
  resetChannel: mocks.resetChannel,
  setCohort: mocks.setCohort,
  setReloadBehavior: mocks.setReloadBehavior,
  stageBundle: mocks.stageBundle,
}));

const importHotUpdater = async () => (await import("./index")).HotUpdater;

describe("HotUpdater client initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.createHttpClient.mockImplementation((baseURL: unknown) => ({
      baseURL,
    }));
    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.configurePlugins.mockReturnValue({});
    mocks.createAppPluginHost.mockImplementation(() => ({
      configurePlugins: mocks.configurePlugins,
    }));
    mocks.createLaunchReporter.mockImplementation(() => ({
      read: mocks.readLaunch,
      appReady: Promise.resolve(),
      emit: mocks.emit,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("forwards HTTP diagnostics after app readiness", async () => {
    const HotUpdater = await importHotUpdater();
    HotUpdater.init({ baseURL: "https://updates.example.com" });
    const onResponse = mocks.createHttpClient.mock.calls[0]![1]!;
    const response: UpdateHttpResponse = {
      resource: "catalog",
      path: "/catalog",
      status: 503,
      body: "Service unavailable",
      bodyTruncated: false,
    };
    onResponse(response);
    expect(mocks.emit).toHaveBeenCalledWith(
      "onHttpResponse",
      expect.any(Function),
    );
    const payload = mocks.emit.mock.calls[0]![1] as () => UpdateHttpResponse;
    expect(payload()).toBe(response);
  });

  it("returns an instance of HotUpdater's methods with each plugin's API under its id", async () => {
    const api = { getString: vi.fn(() => "Hi") };
    mocks.configurePlugins.mockReturnValueOnce({ example: api });
    const HotUpdater = await importHotUpdater();
    const plugin = { id: "example", setup: () => ({ api }) };

    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
      plugins: [plugin],
    });

    expect(hotUpdater.example).toBe(api);
    expect(hotUpdater.getChannel()).toBe("production");
    expect(hotUpdater.wrap).toBeTypeOf("function");
    expect(hotUpdater).not.toHaveProperty("init");
    expect(Object.isFrozen(hotUpdater)).toBe(true);
  });

  it.each(["reload", "checkForUpdate", "wrap", "init"])(
    "refuses a plugin id the instance has, %s, before setting plugins up",
    async (id) => {
      const HotUpdater = await importHotUpdater();

      expect(() =>
        HotUpdater.init({
          baseURL: "https://updates.example.com",
          plugins: [{ id, setup: () => {} }],
        }),
      ).toThrow(`A plugin cannot use the id "${id}"`);
      expect(mocks.configurePlugins).not.toHaveBeenCalled();
    },
  );

  it("types each plugin's API on the instance from the plugins passed", () => {
    const assertTypes = (
      HotUpdater: typeof import("./index").HotUpdater,
      remoteConfig: typeof import("./index").remoteConfig,
      insights: typeof import("./index").insights,
    ) => {
      const hotUpdater = HotUpdater.init({
        baseURL: "https://updates.example.com",
        plugins: [
          insights(),
          remoteConfig({ defaults: { welcome: "Hi", max_items: 20 } }),
          { id: "hooksOnly", setup: () => ({ hooks: {} }) },
        ],
      });
      const welcome: string = hotUpdater.remoteConfig.getString("welcome");
      hotUpdater.insights.setUser({ userId: "user-1" });
      // @ts-expect-error a plugin without an API adds no key
      void hotUpdater.hooksOnly;

      const bare = HotUpdater.init({ baseURL: "https://updates.example.com" });
      // @ts-expect-error no plugin, no plugin API
      void bare.remoteConfig;
      void bare.reload;
      void welcome;
    };

    expect(assertTypes).toBeTypeOf("function");
  });

  it("has only init: every method is on the instance it returns", async () => {
    const HotUpdater = await importHotUpdater();

    expect(Object.keys(HotUpdater)).toEqual(["init"]);
  });

  it("exposes the console ID through the existing getter only", async () => {
    const HotUpdater = await importHotUpdater();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
    });

    expect(hotUpdater.getBundleId()).toBe("release-id");
    expect(hotUpdater).not.toHaveProperty("getReleaseId");
    expect(hotUpdater).not.toHaveProperty("getUpdateId");
  });

  it("initializes a private HTTP client from the required baseURL", async () => {
    const client = { createSession: vi.fn() };
    mocks.createHttpClient.mockReturnValue(client as never);
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });

    expect(mocks.createHttpClient).toHaveBeenCalledWith(
      "https://updates.example.com",
      expect.any(Function),
    );
    expect(mocks.readLaunch).toHaveBeenCalledExactlyOnceWith({
      onError: undefined,
      onNotifyAppReady: undefined,
    });
  });

  it("accepts a functional baseURL without resolving it during init", async () => {
    const resolveBaseURL = vi.fn(() => "https://updates.example.com");
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({ baseURL: resolveBaseURL });

    expect(mocks.createHttpClient).toHaveBeenCalledWith(
      resolveBaseURL,
      expect.any(Function),
    );
    expect(resolveBaseURL).not.toHaveBeenCalled();
  });

  it("sets up plugins with the settings they fetch with, before init reads the launch", async () => {
    const plugin = { id: "example", setup: vi.fn() };
    const onError = vi.fn();
    mocks.readLaunch.mockImplementationOnce(() => {
      expect(mocks.configurePlugins).toHaveBeenCalledOnce();
    });
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      onError,
      plugins: [plugin],
      requestHeaders: { "x-api-key": "client-key" },
      requestTimeout: 1000,
    });
    HotUpdater.init({
      baseURL: "https://other.example.com",
      plugins: [plugin],
    });

    expect(mocks.configurePlugins).toHaveBeenNthCalledWith(1, [plugin], {
      baseURL: "https://updates.example.com",
      onError,
      requestHeaders: { "x-api-key": "client-key" },
      requestTimeout: 1000,
    });
    expect(mocks.configurePlugins).toHaveBeenNthCalledWith(2, [plugin], {
      baseURL: "https://other.example.com",
      onError: undefined,
      requestHeaders: undefined,
      requestTimeout: undefined,
    });
    expect(mocks.createAppPluginHost).toHaveBeenCalledTimes(2);
    expect(mocks.readLaunch).toHaveBeenNthCalledWith(1, {
      onError,
      onNotifyAppReady: undefined,
    });
  });

  it("reports a staged manual download to plugins after the launch", async () => {
    mocks.stageBundle.mockResolvedValueOnce({
      delivery: "archive",
      patchFallback: true,
    });
    mocks.getActiveUpdateState.mockReturnValue({
      activeSelection: {
        bundleId: "next-bundle-id",
        channel: "production",
        kind: "BUNDLE",
        releaseId: "next-release-id",
        scopeKey: "v1:fingerprint:project:ios:cHJvZHVjdGlvbg:hash",
      },
      highestSeenCatalogs: {},
      stableSelection: null,
      verificationPending: true,
    } as never);
    const HotUpdater = await importHotUpdater();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
    });

    await hotUpdater.updateBundle({
      assets: {},
      bundleId: "next-bundle-id",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://updates.example.com/manifest.json",
      status: "UPDATE",
    });

    expect(mocks.emit).toHaveBeenCalledOnce();
    const [name, createPayload] = mocks.emit.mock.calls[0] as [
      string,
      () => unknown,
    ];
    expect(name).toBe("onBundleDownloaded");
    expect(createPayload()).toEqual({
      channel: "production",
      fromBundleId: "bundle-id",
      fromReleaseId: null,
      toBundleId: "next-bundle-id",
      toReleaseId: "next-release-id",
      updateStrategy: "fingerprint",
      delivery: "archive",
      patchFallback: true,
    });
  });

  it("reports a failed manual download to plugins and rethrows it", async () => {
    const error = Object.assign(new Error("hash mismatch"), {
      code: "SIGNATURE_VERIFICATION_FAILED",
      userInfo: { reason: "hash_mismatch", stage: "download" },
    });
    mocks.stageBundle.mockRejectedValueOnce(error);
    const HotUpdater = await importHotUpdater();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
    });

    await expect(
      hotUpdater.updateBundle({
        assets: {},
        bundleId: "next-bundle-id",
        channel: "beta",
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://updates.example.com/manifest.json",
        selection: {
          releaseId: "next-release-id",
          scopeKey: "v1:app-version:project:ios:YmV0YQ",
        },
        status: "UPDATE",
      }),
    ).rejects.toBe(error);

    expect(mocks.reportUpdateError).toHaveBeenCalledWith(
      mocks.emit,
      error,
      "download",
      undefined,
      {
        bundleId: "bundle-id",
        channel: "beta",
        targetBundleId: "next-bundle-id",
        targetReleaseId: "next-release-id",
        updateStrategy: "appVersion",
      },
    );
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("requires baseURL and rejects the removed resolver shape", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() => HotUpdater.init({} as never)).toThrow(
      "baseURL must be provided",
    );
    expect(() => HotUpdater.init({ resolver: {} } as never)).toThrow(
      "baseURL must be provided",
    );
    expect(mocks.createAppPluginHost).not.toHaveBeenCalled();
  });

  it("types init with baseURL but no resolver or catalogId", () => {
    const initOptions = {
      baseURL: "https://updates.example.com",
    } satisfies HotUpdaterInitOptions;
    const resolvedOptions = {
      baseURL: async () => "https://updates.example.com",
    } satisfies HotUpdaterInitOptions;

    const assertRemovedInputsStayRejected = () => {
      // @ts-expect-error baseURL is required
      const missingBaseURL: HotUpdaterInitOptions = {};
      // @ts-expect-error resolver is no longer a public input
      const customResolver: HotUpdaterInitOptions = { resolver: {} };
      const clientCatalog: HotUpdaterInitOptions = {
        // @ts-expect-error catalogId is internal protocol metadata
        catalogId: "project-a",
        baseURL: "https://updates.example.com",
      };
      void missingBaseURL;
      void customResolver;
      void clientCatalog;
    };

    expect(assertRemovedInputsStayRejected).toBeTypeOf("function");
    expect(initOptions.baseURL).toBe("https://updates.example.com");
    expect(resolvedOptions.baseURL).toBeTypeOf("function");
  });

  it("merges settings into checks", async () => {
    const client = { createSession: vi.fn() };
    mocks.createHttpClient.mockReturnValue(client as never);
    const checkOnError = vi.fn();
    const HotUpdater = await importHotUpdater();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });

    await hotUpdater.checkForUpdate({
      onError: checkOnError,
      requestHeaders: { "X-Runtime": "secondary" },
      updateStrategy: "appVersion",
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      client,
      emit: mocks.emit,
      onError: checkOnError,
      requestHeaders: {
        Authorization: "Bearer token",
        "X-Runtime": "secondary",
      },
      requestTimeout: 1000,
      updateStrategy: "appVersion",
    });
  });

  it("keeps each instance's own configuration and plugins when init runs again", async () => {
    const first = { createSession: vi.fn() };
    const second = { createSession: vi.fn() };
    mocks.createHttpClient
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const onError = vi.fn();
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();
    mocks.createLaunchReporter
      .mockReturnValueOnce({
        read: mocks.readLaunch,
        appReady: Promise.resolve(),
        emit: firstEmit,
      })
      .mockReturnValueOnce({
        read: mocks.readLaunch,
        appReady: Promise.resolve(),
        emit: secondEmit,
      });
    const HotUpdater = await importHotUpdater();
    const firstInstance = HotUpdater.init({
      baseURL: "https://updates.example.com",
      requestHeaders: { Authorization: "Bearer first" },
    });
    const secondInstance = HotUpdater.init({
      baseURL: "https://other.example.com",
      onError,
      requestTimeout: 1000,
    });

    await firstInstance.checkForUpdate({ updateStrategy: "appVersion" });
    await secondInstance.checkForUpdate({ updateStrategy: "fingerprint" });

    expect(mocks.checkForUpdate).toHaveBeenNthCalledWith(1, {
      client: first,
      emit: firstEmit,
      onError: undefined,
      requestHeaders: { Authorization: "Bearer first" },
      requestTimeout: undefined,
      updateStrategy: "appVersion",
    });
    expect(mocks.checkForUpdate).toHaveBeenNthCalledWith(2, {
      client: second,
      emit: secondEmit,
      onError,
      requestHeaders: {},
      requestTimeout: 1000,
      updateStrategy: "fingerprint",
    });
    expect(mocks.createAppPluginHost).toHaveBeenCalledTimes(2);
    expect(mocks.createLaunchReporter).toHaveBeenCalledTimes(2);
  });

  it("keeps the install id and leaves user identity to the insights plugin", async () => {
    const HotUpdater = await importHotUpdater();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
    });

    expect(hotUpdater.getInstallId()).toBe("install-id");
    expect(hotUpdater.getMinBundleId()).toBe("min-bundle-id");
    expect(hotUpdater).not.toHaveProperty("setUser");
  });
});

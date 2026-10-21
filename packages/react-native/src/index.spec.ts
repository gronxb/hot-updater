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
    startRuntime: vi.fn(),
    claimLaunchURL: vi.fn((_url: string) => true),
    releaseLaunchURL: vi.fn(),
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
    replayNativeUpdateEvents: vi.fn(),
    reportUpdateError: vi.fn(),
    isChannelSwitched: vi.fn(() => false),
    notifyAppReady: vi.fn(() => ({ status: "UNCHANGED" as const })),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setCohort: vi.fn(),
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

vi.mock("./nativeUpdateEvents", () => ({
  replayNativeUpdateEvents: mocks.replayNativeUpdateEvents,
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
  stageBundle: mocks.stageBundle,
  startRuntime: mocks.startRuntime,
  claimLaunchURL: mocks.claimLaunchURL,
  releaseLaunchURL: mocks.releaseLaunchURL,
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

  it("keeps the API of a plugin whose id is __proto__ as the instance's own property", async () => {
    const api = { read: vi.fn() };
    mocks.configurePlugins.mockReturnValueOnce(
      Object.fromEntries([["__proto__", api]]),
    );
    const HotUpdater = await importHotUpdater();

    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
      plugins: [{ id: "__proto__", setup: () => ({ api }) }],
    });

    expect(
      Object.getOwnPropertyDescriptor(hotUpdater, "__proto__")?.value,
    ).toBe(api);
    expect(Object.getPrototypeOf(hotUpdater)).toBe(Object.prototype);
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

  it("replays native update events before it reads the launch they precede", async () => {
    const order: string[] = [];
    mocks.replayNativeUpdateEvents.mockImplementationOnce((emit: unknown) => {
      expect(emit).toBe(mocks.emit);
      order.push("replay");
    });
    mocks.readLaunch.mockImplementationOnce(() => {
      order.push("launch");
    });
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({ baseURL: "https://updates.example.com" });

    expect(order).toEqual(["replay", "launch"]);
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

  describe("openChannelLink", () => {
    const link = "myapp://hot-updater/channel/pr-12";
    const options = {
      updateStrategy: "fingerprint" as const,
      defaultChannels: ["preview"],
    };
    const open = async (url = link) => {
      const HotUpdater = await importHotUpdater();
      return HotUpdater.init({
        baseURL: "https://updates.example.com",
      }).openChannelLink(url, options);
    };
    const update = () => {
      const updateBundle = vi.fn(async () => true);
      mocks.checkForUpdate.mockResolvedValueOnce({ updateBundle } as never);
      return updateBundle;
    };

    beforeEach(() => {
      mocks.getDefaultChannel.mockReturnValue("preview");
      mocks.getChannel.mockReturnValue("preview");
      mocks.isChannelSwitched.mockReturnValue(false);
      mocks.resetChannel.mockResolvedValue(true as never);
    });

    afterEach(() => {
      mocks.getDefaultChannel.mockReturnValue("production");
      mocks.getChannel.mockReturnValue("production");
      mocks.isChannelSwitched.mockReturnValue(false);
    });

    it("passes any other URL back untouched", async () => {
      await expect(open("myapp://settings")).resolves.toEqual({
        status: "NOT_CHANNEL_LINK",
      });
      expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    });

    it("ignores links in a build whose default channel is not listed", async () => {
      mocks.getDefaultChannel.mockReturnValue("production");
      mocks.getChannel.mockReturnValue("production");

      await expect(open()).resolves.toEqual({
        status: "IGNORED",
        channel: "pr-12",
      });
      expect(mocks.checkForUpdate).not.toHaveBeenCalled();
      expect(mocks.resetChannel).not.toHaveBeenCalled();
    });

    it("installs the channel's bundle and reloads", async () => {
      const updateBundle = update();

      await expect(open()).resolves.toEqual({
        status: "SWITCHED",
        channel: "pr-12",
      });
      expect(mocks.resetChannel).not.toHaveBeenCalled();
      expect(mocks.checkForUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "pr-12",
          updateStrategy: "fingerprint",
        }),
      );
      expect(updateBundle).toHaveBeenCalledTimes(1);
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("resets a switch to another channel before checking", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      update();

      await expect(open()).resolves.toMatchObject({ status: "SWITCHED" });
      expect(mocks.resetChannel.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.checkForUpdate.mock.invocationCallOrder[0]!,
      );
    });

    it("checks the switched channel again without a reset", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-12");

      await expect(open()).resolves.toEqual({
        status: "NO_UPDATE",
        channel: "pr-12",
      });
      expect(mocks.resetChannel).not.toHaveBeenCalled();
      expect(mocks.reload).not.toHaveBeenCalled();
    });

    it("leaves a switch for a link to the default channel", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-12");

      await expect(
        open("myapp://hot-updater/channel/preview"),
      ).resolves.toEqual({ status: "NO_UPDATE", channel: "preview" });
      expect(mocks.resetChannel).toHaveBeenCalledTimes(1);
      // The default channel is checked as the app checks it, with no switch.
      expect(mocks.checkForUpdate).toHaveBeenCalledWith(
        expect.not.objectContaining({ channel: expect.anything() }),
      );
      // The reset restored the built-in bundle, so the app starts it.
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("starts the restored bundle when the check after a reset fails", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      mocks.checkForUpdate.mockRejectedValueOnce(new Error("offline"));

      await expect(open()).rejects.toThrow("offline");
      expect(mocks.resetChannel).toHaveBeenCalledTimes(1);
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("starts the restored bundle when the download after a reset fails", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      mocks.checkForUpdate.mockResolvedValueOnce({
        updateBundle: vi.fn(async () => {
          throw new Error("download failed");
        }),
      } as never);

      await expect(open()).rejects.toThrow("download failed");
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("rejects when the check reports its failure as no update", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      const failure = new Error("catalog request failed");
      // The real checkForUpdate catches the failure, calls onError, and
      // resolves null.
      mocks.checkForUpdate.mockImplementationOnce((async (input: {
        onError?: (error: Error) => void;
      }) => {
        input.onError?.(failure);
        return null;
      }) as never);

      await expect(open()).rejects.toBe(failure);
      // The reset restored the built-in bundle, so the app starts it.
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("reports a failed check without a reset as it is", async () => {
      mocks.checkForUpdate.mockRejectedValueOnce(new Error("offline"));

      await expect(open()).rejects.toThrow("offline");
      expect(mocks.reload).not.toHaveBeenCalled();
    });

    it("opens a launch link once per app process", async () => {
      update();
      mocks.claimLaunchURL.mockReturnValueOnce(false);
      const HotUpdater = await importHotUpdater();
      const hotUpdater = HotUpdater.init({
        baseURL: "https://updates.example.com",
      });

      await expect(
        hotUpdater.openChannelLink(link, { ...options, initial: true }),
      ).resolves.toEqual({ status: "ALREADY_OPENED", channel: "pr-12" });
      expect(mocks.claimLaunchURL).toHaveBeenCalledWith(link);
      expect(mocks.checkForUpdate).not.toHaveBeenCalled();
      expect(mocks.reload).not.toHaveBeenCalled();

      // The first claim of a process opens it.
      await expect(
        hotUpdater.openChannelLink(link, { ...options, initial: true }),
      ).resolves.toEqual({ status: "SWITCHED", channel: "pr-12" });
    });

    it("gives the launch link back when leaving the other channel rejects", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      mocks.resetChannel.mockRejectedValueOnce(
        new Error("storage reset failed"),
      );
      const HotUpdater = await importHotUpdater();

      await expect(
        HotUpdater.init({
          baseURL: "https://updates.example.com",
        }).openChannelLink(link, { ...options, initial: true }),
      ).rejects.toThrow("storage reset failed");
      expect(mocks.releaseLaunchURL).toHaveBeenCalledWith(link);
      expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    });

    it("gives the launch link back when its update could not be applied", async () => {
      mocks.checkForUpdate.mockResolvedValueOnce({
        updateBundle: vi.fn(async () => false),
      } as never);
      const HotUpdater = await importHotUpdater();

      await expect(
        HotUpdater.init({
          baseURL: "https://updates.example.com",
        }).openChannelLink(link, { ...options, initial: true }),
      ).resolves.toEqual({ status: "NO_UPDATE", channel: "pr-12" });
      expect(mocks.releaseLaunchURL).toHaveBeenCalledWith(link);
    });

    it("gives the launch link back when the reload into the channel rejects", async () => {
      update();
      mocks.reload.mockRejectedValueOnce(new Error("restart failed"));
      const HotUpdater = await importHotUpdater();

      await expect(
        HotUpdater.init({
          baseURL: "https://updates.example.com",
        }).openChannelLink(link, { ...options, initial: true }),
      ).rejects.toThrow("restart failed");
      expect(mocks.releaseLaunchURL).toHaveBeenCalledWith(link);
    });

    it("keeps the launch link claimed when it opened", async () => {
      update();
      const HotUpdater = await importHotUpdater();

      await HotUpdater.init({
        baseURL: "https://updates.example.com",
      }).openChannelLink(link, { ...options, initial: true });
      expect(mocks.releaseLaunchURL).not.toHaveBeenCalled();
    });

    it("never consults the launch link for a link the app opens while running", async () => {
      update();
      mocks.claimLaunchURL.mockReturnValue(false);

      await expect(open()).resolves.toEqual({
        status: "SWITCHED",
        channel: "pr-12",
      });
      expect(mocks.claimLaunchURL).not.toHaveBeenCalled();
      mocks.claimLaunchURL.mockReturnValue(true);
    });

    it("claims only channel links", async () => {
      const HotUpdater = await importHotUpdater();

      await expect(
        HotUpdater.init({
          baseURL: "https://updates.example.com",
        }).openChannelLink("myapp://settings", { ...options, initial: true }),
      ).resolves.toEqual({ status: "NOT_CHANNEL_LINK" });
      expect(mocks.claimLaunchURL).not.toHaveBeenCalled();
    });

    it("reports leaving an emptied switched channel as no update, and starts the built-in bundle", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-12");
      const updateBundle = vi.fn(async () => true);
      mocks.checkForUpdate.mockResolvedValueOnce({
        status: "ROLLBACK",
        transitionKind: "USE_BUILTIN",
        updateBundle,
      } as never);

      await expect(open()).resolves.toEqual({
        status: "NO_UPDATE",
        channel: "pr-12",
      });
      expect(updateBundle).toHaveBeenCalledTimes(1);
      expect(mocks.reload).toHaveBeenCalledTimes(1);
    });

    it("refuses to check another channel when the reset fails", async () => {
      mocks.isChannelSwitched.mockReturnValue(true);
      mocks.getChannel.mockReturnValue("pr-11");
      mocks.resetChannel.mockResolvedValue(false as never);

      await expect(open()).rejects.toThrow(
        'Could not leave the "pr-11" channel to open "pr-12".',
      );
      expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    });
  });
});

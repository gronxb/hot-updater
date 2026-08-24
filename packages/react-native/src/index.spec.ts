import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterInitOptions, HotUpdaterOptions } from "./wrap";

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
    createHttpClient: vi.fn((baseURL: unknown) => ({ baseURL })),
    getActiveUpdateState: vi.fn(() => ({
      activeSelection: null,
      highestSeenCatalogs: {},
      stableSelection: null,
      verificationPending: false,
    })),
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
    getMinimumReleaseId: vi.fn(() => "min-bundle-id"),
    getReleaseId: vi.fn(async () => null),
    init: vi.fn(),
    isChannelSwitched: vi.fn(() => false),
    notifyAppReady: vi.fn(() => ({ status: "UNCHANGED" as const })),
    reload: vi.fn(),
    resetChannel: vi.fn(),
    setCohort: vi.fn(),
    setReloadBehavior: vi.fn(),
    setUser: vi.fn(),
    updateBundle: vi.fn(),
    wrap: vi.fn((Component: unknown) => Component),
  };
});

vi.mock("./httpClient", () => ({
  createHttpClient: mocks.createHttpClient,
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  clearCrashHistory: mocks.clearCrashHistory,
  getActiveUpdateState: mocks.getActiveUpdateState,
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
  getMinimumReleaseId: mocks.getMinimumReleaseId,
  getReleaseId: mocks.getReleaseId,
  isChannelSwitched: mocks.isChannelSwitched,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
  resetChannel: mocks.resetChannel,
  setCohort: mocks.setCohort,
  setReloadBehavior: mocks.setReloadBehavior,
  setUser: mocks.setUser,
  updateBundle: mocks.updateBundle,
}));

vi.mock("./wrap", () => ({
  init: mocks.init,
  wrap: mocks.wrap,
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
    mocks.wrap.mockImplementation((Component: unknown) => Component);
  });

  it("initializes a private HTTP client from the required baseURL", async () => {
    const client = { createSession: vi.fn() };
    mocks.createHttpClient.mockReturnValue(client as never);
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({
      analytics: true,
      baseURL: "https://updates.example.com",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });

    expect(mocks.createHttpClient).toHaveBeenCalledWith(
      "https://updates.example.com",
    );
    expect(mocks.init).toHaveBeenCalledWith({
      analytics: true,
      client,
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });
  });

  it("accepts a functional baseURL without resolving it during init", async () => {
    const resolveBaseURL = vi.fn(() => "https://updates.example.com");
    const HotUpdater = await importHotUpdater();

    HotUpdater.init({ baseURL: resolveBaseURL });

    expect(mocks.createHttpClient).toHaveBeenCalledWith(resolveBaseURL);
    expect(resolveBaseURL).not.toHaveBeenCalled();
  });

  it("requires baseURL and rejects the removed resolver shape", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() => HotUpdater.init({} as never)).toThrow(
      "baseURL must be provided",
    );
    expect(() => HotUpdater.init({ resolver: {} } as never)).toThrow(
      "baseURL must be provided",
    );
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("types init and wrap with baseURL but no resolver or authorityId", () => {
    const initOptions = {
      baseURL: "https://updates.example.com",
    } satisfies HotUpdaterInitOptions;
    const wrapOptions = {
      baseURL: async () => "https://updates.example.com",
      updateStrategy: "appVersion",
    } satisfies HotUpdaterOptions;

    const assertRemovedInputsStayRejected = () => {
      // @ts-expect-error baseURL is required
      const missingBaseURL: HotUpdaterInitOptions = {};
      // @ts-expect-error resolver is no longer a public input
      const customResolver: HotUpdaterInitOptions = { resolver: {} };
      const clientAuthority: HotUpdaterInitOptions = {
        // @ts-expect-error authorityId is server-owned
        authorityId: "project-a",
        baseURL: "https://updates.example.com",
      };
      void missingBaseURL;
      void customResolver;
      void clientAuthority;
    };

    expect(assertRemovedInputsStayRejected).toBeTypeOf("function");
    expect(initOptions.baseURL).toBe("https://updates.example.com");
    expect(wrapOptions.updateStrategy).toBe("appVersion");
  });

  it("merges settings and carries the analytics gate to checks", async () => {
    const client = { createSession: vi.fn() };
    mocks.createHttpClient.mockReturnValue(client as never);
    const checkOnError = vi.fn();
    const HotUpdater = await importHotUpdater();
    HotUpdater.init({
      analytics: true,
      baseURL: "https://updates.example.com",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });

    await HotUpdater.checkForUpdate({
      onError: checkOnError,
      requestHeaders: { "X-Runtime": "secondary" },
      updateStrategy: "appVersion",
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      analytics: true,
      client,
      onError: checkOnError,
      requestHeaders: {
        Authorization: "Bearer token",
        "X-Runtime": "secondary",
      },
      requestTimeout: 1000,
      updateStrategy: "appVersion",
    });
  });

  it("normalizes wrap with the same private client contract", async () => {
    const client = { createSession: vi.fn() };
    mocks.createHttpClient.mockReturnValue(client as never);
    const HotUpdater = await importHotUpdater();

    HotUpdater.wrap({
      analytics: true,
      baseURL: "https://updates.example.com",
      updateStrategy: "appVersion",
    });

    expect(mocks.wrap).toHaveBeenCalledWith({
      analytics: true,
      client,
      updateStrategy: "appVersion",
    });
  });

  it.each([
    ["init", "wrap"],
    ["wrap", "init"],
  ] as const)(
    "reports %s and %s mixed usage exactly once",
    async (first, second) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const HotUpdater = await importHotUpdater();
      const configure = (api: "init" | "wrap") => {
        if (api === "init") {
          HotUpdater.init({ baseURL: "https://updates.example.com" });
          return;
        }
        HotUpdater.wrap({
          baseURL: "https://updates.example.com",
          updateStrategy: "appVersion",
        });
      };

      configure(first);
      configure(second);
      configure(second);

      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "HotUpdater.init() and HotUpdater.wrap() must not be used together",
        ),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "use HotUpdater.init() with HotUpdater.checkForUpdate()",
        ),
      );
      consoleError.mockRestore();
    },
  );

  it("rejects removed manual wrap options", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() =>
      HotUpdater.wrap({
        baseURL: "https://updates.example.com",
        updateMode: "manual",
      } as never),
    ).toThrow('HotUpdater.wrap({ updateMode: "manual" }) was removed');
  });

  it("requires initialization before manual update APIs", async () => {
    const HotUpdater = await importHotUpdater();

    expect(() =>
      HotUpdater.checkForUpdate({ updateStrategy: "appVersion" }),
    ).toThrow("requires HotUpdater.wrap() or HotUpdater.init() to be used");
  });

  it("preserves native identity and user APIs", async () => {
    const HotUpdater = await importHotUpdater();

    expect(HotUpdater.getInstallId()).toBe("install-id");
    expect(HotUpdater.getMinimumReleaseId()).toBe("min-bundle-id");
    HotUpdater.setUser({ userId: "user-123", username: "alice" });
    expect(mocks.setUser).toHaveBeenCalledWith({
      userId: "user-123",
      username: "alice",
    });
  });
});

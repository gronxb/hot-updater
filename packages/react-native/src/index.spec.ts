import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
}));

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

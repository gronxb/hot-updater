import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createElement: vi.fn(
    (type: unknown, props: unknown, ...children: unknown[]) => ({
      children,
      props,
      type,
    }),
  ),
  getAppVersion: vi.fn(() => "1.0.0"),
  getBundleId: vi.fn(() => "bundle-id"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "123"),
  getDefaultChannel: vi.fn(() => "production"),
  getFingerprintHash: vi.fn(() => null),
  getMinBundleId: vi.fn(() => "min-bundle-id"),
  isChannelSwitched: vi.fn(() => false),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
  resetChannel: vi.fn(),
  updateBundle: vi.fn(),
  useCallback: vi.fn((callback: unknown) => callback),
  useEffect: vi.fn((effect: () => void | (() => void)) => effect()),
  useLayoutEffect: vi.fn((effect: () => void | (() => void)) => effect()),
  useRef: vi.fn((value: unknown) => ({ current: value })),
  useState: vi.fn((value: unknown) => [value, vi.fn()]),
}));

vi.mock("react", () => ({
  default: {
    createElement: mocks.createElement,
  },
  useCallback: mocks.useCallback,
  useEffect: mocks.useEffect,
  useLayoutEffect: mocks.useLayoutEffect,
  useRef: mocks.useRef,
  useState: mocks.useState,
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./native", () => ({
  getAppVersion: mocks.getAppVersion,
  getBundleId: mocks.getBundleId,
  getChannel: mocks.getChannel,
  getCohort: mocks.getCohort,
  getDefaultChannel: mocks.getDefaultChannel,
  getFingerprintHash: mocks.getFingerprintHash,
  getMinBundleId: mocks.getMinBundleId,
  isChannelSwitched: mocks.isChannelSwitched,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
  resetChannel: mocks.resetChannel,
  updateBundle: mocks.updateBundle,
}));

vi.mock("./store", () => ({
  useHotUpdaterStore: (selector: (state: { progress: number }) => number) =>
    selector({ progress: 0 }),
}));

describe("HotUpdater wrap fetchUpdateInfo errors", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("__DEV__", false);

    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }

    mocks.getAppVersion.mockReturnValue("1.0.0");
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getCohort.mockReturnValue("123");
    mocks.getDefaultChannel.mockReturnValue("production");
    mocks.getFingerprintHash.mockReturnValue(null);
    mocks.getMinBundleId.mockReturnValue("min-bundle-id");
    mocks.isChannelSwitched.mockReturnValue(false);
    mocks.notifyAppReady.mockReturnValue({ status: "STABLE" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onError when the default resolver fails in fetchUpdateInfo", async () => {
    const fetchError = new Error("update server unavailable");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(fetchError));

    const { createDefaultResolver } = await import("./DefaultResolver");
    const { wrap } = await import("./wrap");

    const onError = vi.fn();
    const App = () => null;
    const WrappedApp = wrap({
      resolver: createDefaultResolver("https://updates.example.com"),
      updateMode: "auto",
      updateStrategy: "appVersion",
      onError,
    })(App);

    const renderWrappedApp = WrappedApp as (props: object) => unknown;
    renderWrappedApp({});

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(fetchError);
    });
  });
});

import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterOptions } from "./wrap";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getAppVersion: vi.fn(() => "1.0.0"),
  getBundleId: vi.fn(() => "bundle-id"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "730"),
  getDefaultChannel: vi.fn(() => "production"),
  getFingerprintHash: vi.fn(() => null),
  getInstallId: vi.fn(() => "install-1"),
  isChannelSwitched: vi.fn(() => false),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
}));

vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };
});

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  getAppVersion: mocks.getAppVersion,
  getBundleId: mocks.getBundleId,
  getChannel: mocks.getChannel,
  getCohort: mocks.getCohort,
  getDefaultChannel: mocks.getDefaultChannel,
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  isChannelSwitched: mocks.isChannelSwitched,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
}));

describe("HotUpdater wrap initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.addListener.mockReturnValue(() => {});
    mocks.getAppVersion.mockReturnValue("1.0.0");
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getCohort.mockReturnValue("730");
    mocks.getDefaultChannel.mockReturnValue("production");
    mocks.getFingerprintHash.mockReturnValue(null);
    mocks.getInstallId.mockReturnValue("install-1");
    mocks.isChannelSwitched.mockReturnValue(false);
    mocks.notifyAppReady.mockReturnValue({ status: "STABLE" });
  });

  it("returns void from init and defers notifyAppReady to the next frame", async () => {
    vi.useFakeTimers();

    const requestAnimationFrame = vi.fn(
      (callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);

    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    const result = init({
      resolver,
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
    });

    expect(result).toBeUndefined();
    expect(mocks.notifyAppReady).not.toHaveBeenCalled();
    expect(resolver.notifyAppReady).not.toHaveBeenCalled();

    expect(requestAnimationFrame).toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.notifyAppReady).toHaveBeenCalledWith();
    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      activeBundleId: "bundle-id",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "730",
      status: "STABLE",
      crashedBundleId: null,
      defaultChannel: "production",
      fingerprintHash: null,
      installId: "install-1",
      isChannelSwitched: false,
      platform: "ios",
      previousActiveBundleId: null,
      sdkVersion: "test-sdk-version",
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
    });
  });

  it("calls init onError when app-ready notification fails", async () => {
    vi.useFakeTimers();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("notify failed");
    const onError = vi.fn();
    const requestAnimationFrame = vi.fn(
      (callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockRejectedValue(error),
    };
    const { init } = await import("./wrap");

    init({
      resolver,
      onError,
    });

    await vi.runOnlyPendingTimersAsync();

    expect(onError).toHaveBeenCalledWith(error);
    warn.mockRestore();
  });

  it("warns when the deprecated manual wrap HOC is used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrap } = await import("./wrap");

    wrap({
      resolver: {
        checkUpdate: vi.fn(),
        notifyAppReady: vi.fn(),
      },
      updateMode: "manual",
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'HotUpdater.wrap({ updateMode: "manual" }) is deprecated',
      ),
    );
    warn.mockRestore();
  });

  it("preserves wrapped component prop inference", async () => {
    const { wrap } = await import("./wrap");
    const Component: React.ComponentType<{ title: string }> = () => null;

    const WrappedComponent = wrap({
      resolver: {
        checkUpdate: vi.fn(),
        notifyAppReady: vi.fn(),
      },
      updateMode: "auto",
      updateStrategy: "appVersion",
    })(Component);

    const acceptsTitleProps: React.ComponentType<{ title: string }> =
      WrappedComponent;
    expect(acceptsTitleProps).toBe(WrappedComponent);
  });

  it("types public wrap options as automatic mode by default", () => {
    const autoOptions = {
      baseURL: "https://updates.example.com",
      updateStrategy: "appVersion",
    } satisfies HotUpdaterOptions;
    const explicitAutoOptions = {
      baseURL: "https://updates.example.com",
      updateMode: "auto",
      updateStrategy: "appVersion",
    } satisfies HotUpdaterOptions;
    const manualOptions = {
      baseURL: "https://updates.example.com",
      updateMode: "manual",
    } satisfies HotUpdaterOptions;

    expect(autoOptions.updateStrategy).toBe("appVersion");
    expect(explicitAutoOptions.updateMode).toBe("auto");
    expect(manualOptions.updateMode).toBe("manual");
  });
});

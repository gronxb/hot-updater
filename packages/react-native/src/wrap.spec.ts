// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotifyReadResult } from "./appReady.test-utils";
import type { HotUpdaterClientPlugin } from "./clientPlugin";
import type {
  ActiveUpdateState,
  LaunchTransition,
  NotifyAppReadyResult,
} from "./native";
import type { HotUpdaterWrapOptions, InternalWrapOptions } from "./wrap";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  return {
    addListener: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(),
    getAppVersion: vi.fn(() => "1.0.0"),
    getBundleId: vi.fn(() => "bundle-id"),
    getUpdateId: vi.fn(() => "release-id"),
    getChannel: vi.fn(() => "production"),
    getActiveUpdateState: vi.fn<() => ActiveUpdateState>(),
    getCohort: vi.fn(() => "123"),
    getFingerprintHash: vi.fn(() => "fingerprint-hash"),
    getInstallId: vi.fn(() => "install-id"),
    readNotifyAppReady: vi.fn<
      () => {
        transition: LaunchTransition | null;
        pending: boolean;
        result: NotifyAppReadyResult;
      }
    >(() => createNotifyReadResult()),
    reload: vi.fn(),
  };
});

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
  reportUpdateError: vi.fn(),
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  clearCrashHistory: vi.fn(),
  getAppVersion: mocks.getAppVersion,
  getBaseURL: vi.fn(() => null),
  getBundleId: mocks.getBundleId,
  getUpdateId: mocks.getUpdateId,
  getChannel: mocks.getChannel,
  getActiveUpdateState: mocks.getActiveUpdateState,
  getCohort: mocks.getCohort,
  getCrashHistory: vi.fn(() => []),
  getDefaultChannel: vi.fn(() => "production"),
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  getManifest: vi.fn(),
  getMinBundleId: vi.fn(() => "min-bundle-id"),
  getPublicActiveUpdateState: vi.fn(),
  getStorageItem: vi.fn(() => null),
  isChannelSwitched: vi.fn(() => false),
  notifyAppReady: vi.fn(),
  readNotifyAppReady: mocks.readNotifyAppReady,
  reload: mocks.reload,
  resetChannel: vi.fn(),
  setCohort: vi.fn(),
  setReloadBehavior: vi.fn(),
  setStorageItem: vi.fn(),
  stageBundle: vi.fn(),
}));

/** The settings the instance passes its wrap, as plain mocks. */
const instanceOptions = (
  overrides: Partial<InternalWrapOptions> = {},
): Omit<InternalWrapOptions, keyof HotUpdaterWrapOptions> => ({
  checkForUpdate: mocks.checkForUpdate,
  appReady: async () => undefined,
  onError: vi.fn(),
  ...overrides,
});

describe("hotUpdater.wrap", () => {
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
    mocks.getUpdateId.mockReturnValue("release-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getActiveUpdateState.mockReturnValue({
      activeSelection: null,
      stableSelection: null,
      verificationPending: false,
    });
    mocks.getCohort.mockReturnValue("123");
    mocks.getFingerprintHash.mockReturnValue("fingerprint-hash");
    mocks.getInstallId.mockReturnValue("install-id");
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
  });

  afterEach(cleanup);

  it("reports the console ID when up to date", async () => {
    const onUpdateProcessCompleted = vi.fn();
    const { wrap } = await import("./wrap");
    const WrappedComponent = wrap({
      ...instanceOptions(),
      onUpdateProcessCompleted,
      updateStrategy: "appVersion",
    })(() => null);

    render(createElement(WrappedComponent));

    await waitFor(() =>
      expect(onUpdateProcessCompleted).toHaveBeenCalledWith({
        id: "release-id",
        message: null,
        shouldForceUpdate: false,
        status: "UP_TO_DATE",
      }),
    );
    expect(mocks.checkForUpdate).toHaveBeenCalledExactlyOnceWith({
      updateStrategy: "appVersion",
    });
  });

  it("completes an optional update while its download continues", async () => {
    let complete!: (success: boolean) => void;
    const download = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    mocks.checkForUpdate.mockResolvedValue({
      id: "next",
      status: "UPDATE",
      shouldForceUpdate: false,
      message: null,
      updateBundle: download,
    });
    const { wrap } = await import("./wrap");
    const onUpdateProcessCompleted = vi.fn();
    const Wrapped = wrap({
      ...instanceOptions(),
      updateStrategy: "appVersion",
      onUpdateProcessCompleted,
    })(() => null);

    render(createElement(Wrapped));

    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(onUpdateProcessCompleted).toHaveBeenCalledExactlyOnceWith({
      id: "next",
      message: null,
      shouldForceUpdate: false,
      status: "UPDATE",
    });
    complete(true);
  });

  it("reloads for a forced update only after init has read the launch", async () => {
    let finishLaunchRead!: () => void;
    const appReady = new Promise<void>((resolve) => {
      finishLaunchRead = resolve;
    });
    const download = vi.fn(async () => true);
    mocks.checkForUpdate.mockResolvedValue({
      id: "next",
      status: "UPDATE",
      shouldForceUpdate: true,
      message: null,
      updateBundle: download,
    });
    const { wrap } = await import("./wrap");
    const Wrapped = wrap({
      ...instanceOptions({ appReady: () => appReady }),
      updateStrategy: "appVersion",
    })(() => null);

    render(createElement(Wrapped));

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(download).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();

    finishLaunchRead();

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    expect(download).toHaveBeenCalledOnce();
  });

  it("reports a failed forced download to init's onError and shows the app", async () => {
    const onError = vi.fn();
    mocks.checkForUpdate.mockResolvedValue({
      id: "next",
      status: "UPDATE",
      shouldForceUpdate: true,
      message: null,
      updateBundle: vi.fn(async () => false),
    });
    const { wrap } = await import("./wrap");
    const Wrapped = wrap({
      ...instanceOptions({ onError }),
      updateStrategy: "appVersion",
      fallbackComponent: () => createElement("div", null, "updating"),
    })(() => createElement("div", null, "app"));

    render(createElement(Wrapped));

    await screen.findByText("app");
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("New update was found but failed to download the bundle."),
    );
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("checks with init's settings and reads the launch once, in init", async () => {
    const { HotUpdater } = await import("./index");
    const onAppReady = vi.fn();
    const recorder: HotUpdaterClientPlugin = {
      id: "recorder",
      setup: () => ({ hooks: { onAppReady } }),
    };
    const onError = vi.fn();
    const onUpdateProcessCompleted = vi.fn();
    const hotUpdater = HotUpdater.init({
      baseURL: "https://updates.example.com",
      onError,
      plugins: [recorder],
      requestHeaders: { "x-api-key": "client-key" },
      requestTimeout: 1000,
    });

    render(
      createElement(
        hotUpdater.wrap({
          onUpdateProcessCompleted,
          updateStrategy: "fingerprint",
        })(() => null),
      ),
    );

    await waitFor(() =>
      expect(onUpdateProcessCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ status: "UP_TO_DATE" }),
      ),
    );
    expect(mocks.checkForUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        onError,
        requestHeaders: { "x-api-key": "client-key" },
        requestTimeout: 1000,
        updateStrategy: "fingerprint",
      }),
    );
    expect(mocks.readNotifyAppReady).toHaveBeenCalledOnce();
    expect(onAppReady).toHaveBeenCalledExactlyOnceWith({
      status: "UNCHANGED",
      channel: "production",
      bundleId: "bundle-id",
      releaseId: null,
    });
  });

  it("has init defer reading the launch to the next frame", async () => {
    vi.useFakeTimers();

    const requestAnimationFrame = vi.fn(
      (callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const { HotUpdater } = await import("./index");
    const onAppReady = vi.fn();

    HotUpdater.init({
      baseURL: "https://updates.example.com",
      plugins: [{ id: "recorder", setup: () => ({ hooks: { onAppReady } }) }],
    });

    expect(mocks.readNotifyAppReady).not.toHaveBeenCalled();
    expect(onAppReady).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledWith();
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("preserves wrapped component prop inference", async () => {
    const { wrap } = await import("./wrap");
    const Component: ComponentType<{ title: string }> = () => null;

    const WrappedComponent = wrap({
      ...instanceOptions(),
      updateStrategy: "appVersion",
    })(Component);

    const acceptsTitleProps: ComponentType<{ title: string }> =
      WrappedComponent;
    expect(acceptsTitleProps).toBe(WrappedComponent);
  });

  it("types wrap options as the update flow alone", () => {
    const options = {
      updateStrategy: "appVersion",
    } satisfies HotUpdaterWrapOptions;

    const assertConfigurationStaysInInit = () => {
      const withBaseURL: HotUpdaterWrapOptions = {
        updateStrategy: "appVersion",
        // @ts-expect-error the server is configured by HotUpdater.init.
        baseURL: "https://updates.example.com",
      };
      void withBaseURL;
    };

    expect(assertConfigurationStaysInInit).toBeTypeOf("function");
    expect(options.updateStrategy).toBe("appVersion");
  });
});

// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotifyReadResult } from "./appReady.test-utils";
import type { HotUpdaterClientPlugin } from "./clientPlugin";
import type {
  ActiveUpdateState,
  LaunchTransition,
  NotifyAppReadyResult,
} from "./native";
import type { HotUpdaterOptions } from "./wrap";

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
        previousProcessExit: string | null;
        pending: boolean;
        result: NotifyAppReadyResult;
      }
    >(() => createNotifyReadResult()),
    reload: vi.fn(),
  };
});

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  getAppVersion: mocks.getAppVersion,
  getBundleId: mocks.getBundleId,
  getUpdateId: mocks.getUpdateId,
  getChannel: mocks.getChannel,
  getActiveUpdateState: mocks.getActiveUpdateState,
  getCohort: mocks.getCohort,
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  readNotifyAppReady: mocks.readNotifyAppReady,
  reload: mocks.reload,
}));

const createClient = () => ({
  client: {
    createSession: vi.fn(async () => ({
      fetchReleaseCatalog: vi.fn(),
      resolveArtifact: vi.fn(),
    })),
  },
});

const configureRecorder = async () => {
  const { configurePlugins } = await import("./pluginHost");
  const onAppReady = vi.fn();
  const plugin: HotUpdaterClientPlugin = {
    id: "recorder",
    setup: () => ({ onAppReady }),
  };
  configurePlugins([plugin], { baseURL: "https://updates.example.com" });
  return onAppReady;
};

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

  it("reports the console ID when up to date and the launch to plugins", async () => {
    const onAppReady = await configureRecorder();
    const onUpdateProcessCompleted = vi.fn();
    const { client } = createClient();
    const { wrap } = await import("./wrap");
    const WrappedComponent = wrap({
      client,
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
    expect(onAppReady).toHaveBeenCalledExactlyOnceWith({
      status: "UNCHANGED",
      channel: "production",
      bundleId: "bundle-id",
      releaseId: null,
      previousProcessExit: null,
    });
    expect(mocks.checkForUpdate).toHaveBeenCalledWith({
      client,
      onError: undefined,
      requestHeaders: undefined,
      requestTimeout: undefined,
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
      client: createClient().client,
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

  it("returns void from init and defers notifyAppReady to the next frame", async () => {
    vi.useFakeTimers();

    const requestAnimationFrame = vi.fn(
      (callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const onAppReady = await configureRecorder();

    const { client } = createClient();
    const { init } = await import("./wrap");

    const result = init({
      client,
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
    });

    expect(result).toBeUndefined();
    expect(mocks.readNotifyAppReady).not.toHaveBeenCalled();
    expect(onAppReady).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledWith();
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("does not accept a manual wrap HOC", async () => {
    const { wrap } = await import("./wrap");

    wrap({
      client: createClient().client,
      updateStrategy: "appVersion",
    });
  });

  it("preserves wrapped component prop inference", async () => {
    const { wrap } = await import("./wrap");
    const Component: ComponentType<{ title: string }> = () => null;

    const WrappedComponent = wrap({
      client: createClient().client,
      updateStrategy: "appVersion",
    })(Component);

    const acceptsTitleProps: ComponentType<{ title: string }> =
      WrappedComponent;
    expect(acceptsTitleProps).toBe(WrappedComponent);
  });

  it("types public wrap options as automatic mode by default", () => {
    const autoOptions = {
      baseURL: "https://updates.example.com",
      updateStrategy: "appVersion",
    } satisfies HotUpdaterOptions;

    const assertRemovedOptionStaysRejected = () => {
      const withInsights: HotUpdaterOptions = {
        baseURL: "https://updates.example.com",
        updateStrategy: "appVersion",
        // @ts-expect-error Insights is the insights() plugin, not an option.
        insights: true,
      };
      void withInsights;
    };

    expect(assertRemovedOptionStaysRejected).toBeTypeOf("function");
    expect(autoOptions.updateStrategy).toBe("appVersion");
  });
});

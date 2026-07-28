// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterOptions } from "./wrap";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getBundleId: vi.fn(() => "bundle-id"),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
}));

const platformMock = vi.hoisted(() => {
  const platform: { OS: "android" | "ios" } = { OS: "ios" };
  return platform;
});

vi.mock("react-native", () => ({
  Platform: platformMock,
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  getBundleId: mocks.getBundleId,
  notifyAppReady: mocks.notifyAppReady,
  reload: mocks.reload,
}));

describe("HotUpdater wrap initialization", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.addListener.mockReturnValue(() => {});
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.notifyAppReady.mockReturnValue({ status: "STABLE" });
    platformMock.OS = "ios";
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
      status: "STABLE",
      crashedBundleId: undefined,
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

  it("does not reload during an iOS rollback", async () => {
    // Given: the running iOS bundle has been disabled.
    const updateBundle = vi.fn().mockResolvedValue(true);
    mocks.checkForUpdate.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000000",
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      updateBundle,
    });
    const onUpdateProcessCompleted = vi.fn();
    const { wrap } = await import("./wrap");
    const WrappedComponent = wrap({
      resolver: {
        checkUpdate: vi.fn(),
      },
      updateMode: "auto",
      updateStrategy: "appVersion",
      onUpdateProcessCompleted,
    })(() => null);

    // When: the automatic startup update check applies the rollback.
    render(React.createElement(WrappedComponent));
    await waitFor(() => expect(updateBundle).toHaveBeenCalledOnce());

    // Then: storage is reset without an unsafe in-process iOS reload.
    expect(mocks.reload).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onUpdateProcessCompleted).toHaveBeenCalledWith({
        id: "00000000-0000-0000-0000-000000000000",
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    );
  });

  it.each([
    ["ios", "UPDATE"],
    ["android", "ROLLBACK"],
  ] as const)(
    "reloads on %s when the forced update status is %s",
    async (os, status) => {
      // Given: the forced update can safely reload on this platform and status.
      platformMock.OS = os;
      const updateBundle = vi.fn().mockResolvedValue(true);
      mocks.checkForUpdate.mockResolvedValue({
        id: "bundle-id",
        message: null,
        shouldForceUpdate: true,
        status,
        updateBundle,
      });
      const { wrap } = await import("./wrap");
      const WrappedComponent = wrap({
        resolver: {
          checkUpdate: vi.fn(),
        },
        updateMode: "auto",
        updateStrategy: "appVersion",
      })(() => null);

      // When: the automatic startup update check applies the update.
      render(React.createElement(WrappedComponent));
      await waitFor(() => expect(updateBundle).toHaveBeenCalledOnce());

      // Then: the running app reloads into the selected bundle.
      await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    },
  );

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

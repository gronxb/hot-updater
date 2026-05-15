import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HotUpdaterOptions } from "./wrap";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getBundleId: vi.fn(() => "bundle-id"),
  notifyAppReady: vi.fn(() => ({ status: "STABLE" })),
  reload: vi.fn(),
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
    const manualOptions = {
      baseURL: "https://updates.example.com",
      updateMode: "manual",
    } satisfies HotUpdaterOptions;
    const autoModeOptions = {
      baseURL: "https://updates.example.com",
      updateMode: "auto",
      updateStrategy: "appVersion",
    } as const;

    // @ts-expect-error HotUpdater.wrap defaults to auto and no longer accepts updateMode: "auto".
    void (autoModeOptions satisfies HotUpdaterOptions);

    expect(autoOptions.updateStrategy).toBe("appVersion");
    expect(manualOptions.updateMode).toBe("manual");
  });
});

import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotifyAppReadyResult } from "./native";
import type { HotUpdaterOptions } from "./wrap";

const createNotifyReadResult = (
  result: NotifyAppReadyResult = { status: "UNCHANGED" },
  pending = false,
) => ({
  pending,
  result,
});

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getBundleId: vi.fn(() => "bundle-id"),
  readNotifyAppReady: vi.fn(() => createNotifyReadResult()),
  reload: vi.fn(),
}));

vi.mock("./checkForUpdate", () => ({
  checkForUpdate: mocks.checkForUpdate,
}));

vi.mock("./native", () => ({
  addListener: mocks.addListener,
  getBundleId: mocks.getBundleId,
  readNotifyAppReady: mocks.readNotifyAppReady,
  reload: mocks.reload,
}));

const stubNotifyFrame = () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: (timestamp: number) => void) => {
      setTimeout(() => callback(0), 0);
      return 1;
    }),
  );
};

describe("HotUpdater wrap initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.addListener.mockReturnValue(() => {});
    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
  });

  it("returns void from init and defers notifyAppReady to the next frame", async () => {
    stubNotifyFrame();
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    const result = init({
      resolver,
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
    });

    expect(result).toBeUndefined();
    expect(mocks.readNotifyAppReady).not.toHaveBeenCalled();
    expect(resolver.notifyAppReady).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledWith();
    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      status: "STABLE",
    });
  });

  it("waits for native launch verification before reporting recovery", async () => {
    stubNotifyFrame();
    const recoveredResult = {
      fromBundleId: "bundle-b",
      status: "RECOVERED",
      toBundleId: "bundle-a",
      updateStrategy: "appVersion",
    } as const satisfies NotifyAppReadyResult;
    mocks.readNotifyAppReady
      .mockReturnValueOnce(createNotifyReadResult(undefined, true))
      .mockReturnValueOnce(createNotifyReadResult(recoveredResult));
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ onNotifyAppReady, resolver });
    await vi.runAllTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledTimes(2);
    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      crashedBundleId: "bundle-b",
      requestHeaders: undefined,
      requestTimeout: undefined,
      status: "RECOVERED",
    });
    expect(onNotifyAppReady).toHaveBeenCalledWith(recoveredResult);
  });

  it("reports resolver readiness errors without suppressing the callback", async () => {
    stubNotifyFrame();
    const failure = new Error("readiness failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onError = vi.fn();
    const onNotifyAppReady = vi.fn();
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockRejectedValue(failure),
    };
    const { init } = await import("./wrap");

    init({ onError, onNotifyAppReady, resolver });
    await vi.runOnlyPendingTimersAsync();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
    expect(warn).toHaveBeenCalledWith(
      "[HotUpdater] Resolver notifyAppReady failed:",
      failure,
    );
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

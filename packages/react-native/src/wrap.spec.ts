import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NotifyAppReadyAnalyticsEvent,
  NotifyAppReadyResult,
} from "./native";
import type { HotUpdaterOptions } from "./wrap";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

const createNotifyReadResult = (
  result: NotifyAppReadyResult = { status: "UNCHANGED" },
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null = null,
  pending = false,
): {
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null;
  pending: boolean;
  result: NotifyAppReadyResult;
} => ({
  analyticsEvent,
  pending,
  result,
});

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getAppVersion: vi.fn(() => "1.0.0"),
  getBundleId: vi.fn(() => "bundle-id"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "123"),
  getFingerprintHash: vi.fn(() => "fingerprint-hash"),
  getInstallId: vi.fn(() => "install-id"),
  getPersistedUserIdentity: vi.fn(() => ({})),
  readNotifyAppReady: vi.fn<
    () => {
      analyticsEvent: NotifyAppReadyAnalyticsEvent | null;
      pending: boolean;
      result: NotifyAppReadyResult;
    }
  >(() => createNotifyReadResult()),
  reload: vi.fn(),
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
  getFingerprintHash: mocks.getFingerprintHash,
  getInstallId: mocks.getInstallId,
  getPersistedUserIdentity: mocks.getPersistedUserIdentity,
  readNotifyAppReady: mocks.readNotifyAppReady,
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
    mocks.getPersistedUserIdentity.mockReturnValue({});
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getCohort.mockReturnValue("123");
    mocks.getFingerprintHash.mockReturnValue("fingerprint-hash");
    mocks.getInstallId.mockReturnValue("install-id");
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
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
    expect(mocks.readNotifyAppReady).not.toHaveBeenCalled();
    expect(resolver.notifyAppReady).not.toHaveBeenCalled();

    expect(requestAnimationFrame).toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledWith();
    expect(resolver.notifyAppReady).not.toHaveBeenCalled();
  });

  it("waits for native launch verification before sending analytics", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      }),
    );

    mocks.readNotifyAppReady
      .mockReturnValueOnce(createNotifyReadResult(undefined, null, true))
      .mockReturnValueOnce(
        createNotifyReadResult(
          {
            fromBundleId: "bundle-a",
            status: "UPDATE_APPLIED",
            toBundleId: "bundle-b",
          },
          {
            fromBundleId: "bundle-a",
            toBundleId: "bundle-b",
            type: "UPDATE_APPLIED",
            updateStrategy: "appVersion",
          },
        ),
      );

    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    init({ analytics: true, resolver });

    await vi.runAllTimersAsync();

    expect(mocks.readNotifyAppReady).toHaveBeenCalledTimes(2);
    expect(resolver.notifyAppReady).toHaveBeenCalledTimes(1);
  });

  it("sends automatic analytics only from init when enabled", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      }),
    );

    mocks.readNotifyAppReady.mockReturnValue(
      createNotifyReadResult(
        {
          fromBundleId: "bundle-a",
          status: "UPDATE_APPLIED",
          toBundleId: "bundle-b",
        },
        {
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
          type: "UPDATE_APPLIED",
          updateStrategy: "fingerprint",
        },
      ),
    );

    mocks.getPersistedUserIdentity.mockReturnValue({
      userId: "user-123",
      username: "alice",
    });

    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    init({
      analytics: true,
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
      resolver,
    });

    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: "bundle-a",
      installId: "install-id",
      platform: "ios",
      requestHeaders: {
        Authorization: "Bearer token",
      },
      requestTimeout: 1000,
      toBundleId: "bundle-b",
      type: "UPDATE_APPLIED",
      updateStrategy: "fingerprint",
      userId: "user-123",
      username: "alice",
    });
  });

  it("guards automatic analytics to a single delivery attempt per runtime", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      }),
    );

    mocks.readNotifyAppReady.mockReturnValue(
      createNotifyReadResult(
        {
          fromBundleId: "bundle-a",
          status: "RECOVERED",
          toBundleId: "bundle-b",
        },
        {
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
          type: "RECOVERED",
          updateStrategy: "appVersion",
        },
      ),
    );

    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    init({ analytics: true, resolver });
    init({ analytics: true, resolver });

    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledTimes(1);
  });

  it("warns without interrupting app readiness when analytics transport fails", async () => {
    vi.useFakeTimers();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("Expected HTTP 204 from /events, received 404");
    const onError = vi.fn();
    const onNotifyAppReady = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        setTimeout(() => callback(0), 0);
        return 1;
      }),
    );
    mocks.readNotifyAppReady.mockReturnValue(
      createNotifyReadResult(
        {
          fromBundleId: "bundle-a",
          status: "UPDATE_APPLIED",
          toBundleId: "bundle-b",
        },
        {
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
          type: "UPDATE_APPLIED",
          updateStrategy: "appVersion",
        },
      ),
    );
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockRejectedValue(error),
    };
    const { init } = await import("./wrap");

    init({
      analytics: true,
      onError,
      onNotifyAppReady,
      resolver,
    });

    await vi.runOnlyPendingTimersAsync();

    expect(onError).toHaveBeenCalledWith(error);
    expect(warn).toHaveBeenCalledWith(
      "[HotUpdater] Automatic notifyAppReady analytics failed:",
      error,
    );
    expect(onNotifyAppReady).toHaveBeenCalledWith({
      fromBundleId: "bundle-a",
      status: "UPDATE_APPLIED",
      toBundleId: "bundle-b",
    });
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

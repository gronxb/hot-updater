import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NotifyAppReadyAnalyticsEvent,
  NotifyAppReadyResult,
} from "./native";
import {
  createNotifyReadResult,
  stubNotifyFrame,
} from "./notifyAppReadyAnalytics.test-utils";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

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

describe("automatic notifyAppReady analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.getAppVersion.mockReturnValue("1.0.0");
    mocks.addListener.mockReturnValue(() => {});
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getCohort.mockReturnValue("123");
    mocks.getFingerprintHash.mockReturnValue("fingerprint-hash");
    mocks.getInstallId.mockReturnValue("install-id");
    mocks.getPersistedUserIdentity.mockReturnValue({});
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
  });

  it("sends UPDATE_APPLIED with transition metadata and invokes readiness", async () => {
    stubNotifyFrame();
    mocks.getPersistedUserIdentity.mockReturnValue({
      userId: "user-123",
      username: "alice",
    });
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

    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
      notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
    };
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({
      analytics: true,
      onNotifyAppReady,
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      resolver,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      status: "STABLE",
    });
    expect(resolver.notifyAppReadyAnalytics).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: "bundle-a",
      installId: "install-id",
      platform: "ios",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      toBundleId: "bundle-b",
      type: "UPDATE_APPLIED",
      updateStrategy: "fingerprint",
      userId: "user-123",
      username: "alice",
    });
    expect(onNotifyAppReady).toHaveBeenCalledWith({
      fromBundleId: "bundle-a",
      status: "UPDATE_APPLIED",
      toBundleId: "bundle-b",
    });
  });

  it("sends RECOVERED with directional ids and invokes readiness", async () => {
    stubNotifyFrame();
    mocks.readNotifyAppReady.mockReturnValue(
      createNotifyReadResult(
        {
          fromBundleId: "bundle-b",
          status: "RECOVERED",
          toBundleId: "bundle-a",
        },
        {
          fromBundleId: "bundle-b",
          toBundleId: "bundle-a",
          type: "RECOVERED",
          updateStrategy: "appVersion",
        },
      ),
    );
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
      notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
    };
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: true, onNotifyAppReady, resolver });
    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      crashedBundleId: "bundle-b",
      requestHeaders: undefined,
      requestTimeout: undefined,
      status: "RECOVERED",
    });
    expect(resolver.notifyAppReadyAnalytics).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: "bundle-b",
      installId: "install-id",
      platform: "ios",
      requestHeaders: undefined,
      requestTimeout: undefined,
      toBundleId: "bundle-a",
      type: "RECOVERED",
      updateStrategy: "appVersion",
    });
    expect(onNotifyAppReady).toHaveBeenCalledWith({
      fromBundleId: "bundle-b",
      status: "RECOVERED",
      toBundleId: "bundle-a",
    });
  });

  it("sends one UNCHANGED event for repeated init calls", async () => {
    stubNotifyFrame();
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
      notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
    };
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: true, onNotifyAppReady, resolver });
    init({ analytics: true, onNotifyAppReady, resolver });
    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledTimes(2);
    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      status: "STABLE",
    });
    expect(resolver.notifyAppReadyAnalytics).toHaveBeenCalledTimes(1);
    expect(resolver.notifyAppReadyAnalytics).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: null,
      installId: "install-id",
      platform: "ios",
      requestHeaders: undefined,
      requestTimeout: undefined,
      toBundleId: "bundle-id",
      type: "UNCHANGED",
      updateStrategy: null,
    });
    expect(onNotifyAppReady).toHaveBeenCalledTimes(2);
    expect(onNotifyAppReady).toHaveBeenNthCalledWith(1, {
      status: "UNCHANGED",
    });
    expect(onNotifyAppReady).toHaveBeenNthCalledWith(2, {
      status: "UNCHANGED",
    });
  });

  it("skips automatic analytics when disabled while preserving readiness", async () => {
    stubNotifyFrame();
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockResolvedValue(undefined),
      notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
    };
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: false, onNotifyAppReady, resolver });
    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      status: "STABLE",
    });
    expect(resolver.notifyAppReadyAnalytics).not.toHaveBeenCalled();
    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
  });
});

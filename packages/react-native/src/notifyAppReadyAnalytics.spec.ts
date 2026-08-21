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

const createClient = () => {
  const sendAnalyticsEvent = vi.fn().mockResolvedValue(undefined);
  return {
    client: {
      createSession: vi.fn(async () => ({
        fetchReleaseCatalog: vi.fn(),
        resolveArtifact: vi.fn(),
        sendAnalyticsEvent,
      })),
    },
    sendAnalyticsEvent,
  };
};

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

    const { client, sendAnalyticsEvent } = createClient();
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({
      analytics: true,
      onNotifyAppReady,
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      client,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(sendAnalyticsEvent).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: "bundle-a",
      fromReleaseId: null,
      installId: "install-id",
      platform: "ios",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1000,
      toBundleId: "bundle-b",
      toReleaseId: null,
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
    const { client, sendAnalyticsEvent } = createClient();
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: true, client, onNotifyAppReady });
    await vi.runOnlyPendingTimersAsync();

    expect(sendAnalyticsEvent).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: "bundle-b",
      fromReleaseId: null,
      installId: "install-id",
      platform: "ios",
      requestHeaders: undefined,
      requestTimeout: undefined,
      toBundleId: "bundle-a",
      toReleaseId: null,
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
    const { client, sendAnalyticsEvent } = createClient();
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: true, client, onNotifyAppReady });
    init({ analytics: true, client, onNotifyAppReady });
    await vi.runOnlyPendingTimersAsync();

    expect(sendAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(sendAnalyticsEvent).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "123",
      fingerprintHash: "fingerprint-hash",
      fromBundleId: null,
      fromReleaseId: null,
      installId: "install-id",
      platform: "ios",
      requestHeaders: undefined,
      requestTimeout: undefined,
      toBundleId: "bundle-id",
      toReleaseId: null,
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
    const { client, sendAnalyticsEvent } = createClient();
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({ analytics: false, client, onNotifyAppReady });
    await vi.runOnlyPendingTimersAsync();

    expect(sendAnalyticsEvent).not.toHaveBeenCalled();
    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
  });
});

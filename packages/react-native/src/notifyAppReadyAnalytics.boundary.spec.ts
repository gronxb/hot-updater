import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NotifyAppReadyAnalyticsEvent,
  NotifyAppReadyResult,
} from "./native";
import {
  createNotifyReadResult,
  stubNotifyFrame,
} from "./notifyAppReadyAnalytics.test-utils";

const platformState = vi.hoisted((): { OS: "ios" | "android" } => ({
  OS: "ios",
}));

vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  Platform: platformState,
}));

const nativePersistence = vi.hoisted(() => {
  let persistedInstallId = "install-persisted";

  return {
    getConstants: vi.fn(() => ({
      APP_VERSION: "1.0.0",
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    })),
    getInstallId: vi.fn(() => persistedInstallId),
    setPersistedInstallId: (installId: string) => {
      persistedInstallId = installId;
    },
  };
});

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(() => () => {}),
  checkForUpdate: vi.fn(),
  getAppVersion: vi.fn<() => string | undefined>(() => "1.0.0"),
  getBundleId: vi.fn<() => string | undefined>(() => "bundle-id"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "123"),
  getFingerprintHash: vi.fn(() => "fingerprint-hash"),
  getInstallId: vi.fn<() => string | undefined>(() => "install-id"),
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

vi.mock("./specs/NativeHotUpdater", () => ({
  default: nativePersistence,
}));

const createResolver = () => ({
  checkUpdate: vi.fn(),
  notifyAppReady: vi.fn().mockResolvedValue(undefined),
  notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
});

describe("automatic notifyAppReady analytics boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    platformState.OS = "ios";

    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }

    mocks.addListener.mockReturnValue(() => {});
    mocks.getAppVersion.mockReturnValue("1.0.0");
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getCohort.mockReturnValue("123");
    mocks.getFingerprintHash.mockReturnValue("fingerprint-hash");
    mocks.getInstallId.mockReturnValue("install-id");
    mocks.getPersistedUserIdentity.mockReturnValue({});
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
    nativePersistence.getConstants.mockClear();
    nativePersistence.getInstallId.mockClear();
    nativePersistence.setPersistedInstallId("install-persisted");
  });

  it("warns when resolver analytics transport is missing and preserves readiness", async () => {
    stubNotifyFrame();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onError = vi.fn();
    const onNotifyAppReady = vi.fn();
    const { init } = await import("./wrap");

    init({
      analytics: true,
      onError,
      onNotifyAppReady,
      resolver: { checkUpdate: vi.fn() },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(onError).not.toHaveBeenCalled();
    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
    expect(warn).toHaveBeenCalledWith(
      "[HotUpdater] Automatic notifyAppReady analytics failed:",
      expect.objectContaining({
        message:
          "[HotUpdater] Automatic analytics requires resolver.notifyAppReadyAnalytics().",
      }),
    );
    warn.mockRestore();
  });

  it("delivers legacy readiness resolver failures through onError", async () => {
    stubNotifyFrame();
    const failure = new Error("legacy readiness failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onError = vi.fn();
    const onNotifyAppReady = vi.fn();
    const resolver = {
      checkUpdate: vi.fn(),
      notifyAppReady: vi.fn().mockRejectedValue(failure),
      notifyAppReadyAnalytics: vi.fn().mockResolvedValue(undefined),
    };
    const { init } = await import("./wrap");

    init({
      analytics: false,
      onError,
      onNotifyAppReady,
      resolver,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(resolver.notifyAppReady).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      status: "STABLE",
    });
    expect(resolver.notifyAppReadyAnalytics).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
    expect(warn).toHaveBeenCalledWith(
      "[HotUpdater] Resolver notifyAppReady failed:",
      failure,
    );
    warn.mockRestore();
  });

  it.each([
    { label: "throws", value: new Error("native install id unavailable") },
    { label: "returns no identity", value: undefined },
  ])(
    "warns for a missing native install identity when it $label",
    async ({ value }) => {
      stubNotifyFrame();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onError = vi.fn();
      const onNotifyAppReady = vi.fn();
      if (value instanceof Error) {
        mocks.getInstallId.mockImplementation(() => {
          throw value;
        });
      } else {
        mocks.getInstallId.mockReturnValue(value);
      }
      const resolver = createResolver();
      const { init } = await import("./wrap");

      init({ analytics: true, onError, onNotifyAppReady, resolver });
      await vi.runOnlyPendingTimersAsync();

      expect(resolver.notifyAppReadyAnalytics).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
      expect(warn).toHaveBeenCalledWith(
        "[HotUpdater] Automatic notifyAppReady analytics failed:",
        expect.any(Error),
      );
      warn.mockRestore();
    },
  );

  it.each([
    { label: "throws", value: new Error("native bundle id unavailable") },
    { label: "returns no bundle", value: undefined },
  ])(
    "warns for a missing current bundle when getBundleId $label",
    async ({ value }) => {
      stubNotifyFrame();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onError = vi.fn();
      const onNotifyAppReady = vi.fn();
      if (value instanceof Error) {
        mocks.getBundleId.mockImplementation(() => {
          throw value;
        });
      } else {
        mocks.getBundleId.mockReturnValue(value);
      }
      const resolver = createResolver();
      const { init } = await import("./wrap");

      init({ analytics: true, onError, onNotifyAppReady, resolver });
      await vi.runOnlyPendingTimersAsync();

      expect(resolver.notifyAppReadyAnalytics).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
      expect(warn).toHaveBeenCalledWith(
        "[HotUpdater] Automatic notifyAppReady analytics failed:",
        expect.any(Error),
      );
      warn.mockRestore();
    },
  );

  it.each(["ios", "android"] as const)(
    "reads persisted install id through native.ts across JS module resets on %s",
    async (platform) => {
      platformState.OS = platform;
      nativePersistence.setPersistedInstallId("install-persisted");
      const native =
        await vi.importActual<typeof import("./native")>("./native");

      expect(native.getInstallId()).toBe("install-persisted");
      vi.resetModules();
      const nativeAfterReset =
        await vi.importActual<typeof import("./native")>("./native");

      expect(nativeAfterReset.getInstallId()).toBe("install-persisted");
      expect(nativePersistence.getInstallId).toHaveBeenCalledTimes(2);
    },
  );
});

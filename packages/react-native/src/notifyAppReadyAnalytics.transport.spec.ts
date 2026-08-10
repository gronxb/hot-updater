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

const failureCases = [
  { label: "400", responseStatus: 400 },
  { label: "404", responseStatus: 404 },
  { label: "500", responseStatus: 500 },
  {
    error: Object.assign(new Error("request aborted"), { name: "AbortError" }),
    label: "timeout",
  },
  { error: new Error("network unavailable"), label: "network" },
] as const;

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

describe("automatic notifyAppReady transport failures", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();

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
  });

  it.each(failureCases)(
    "warns and preserves UNCHANGED readiness for a real resolver $label failure",
    async (failureCase) => {
      stubNotifyFrame();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onError = vi.fn();
      const onNotifyAppReady = vi.fn();
      const fetchMock = vi.fn(async () => {
        if ("error" in failureCase) {
          throw failureCase.error;
        }

        return new Response(null, { status: failureCase.responseStatus });
      });
      vi.stubGlobal("fetch", fetchMock);
      Reflect.set(globalThis, "HotUpdater", {
        SDK_VERSION: "test-sdk-version",
      });

      try {
        const [{ createDefaultResolver }, { init }] = await Promise.all([
          import("./DefaultResolver"),
          import("./wrap"),
        ]);
        const resolver = createDefaultResolver(
          "https://updates.example.test/hot-updater",
        );

        init({ analytics: true, onError, onNotifyAppReady, resolver });
        await vi.runOnlyPendingTimersAsync();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(onNotifyAppReady).toHaveBeenCalledWith({
          status: "UNCHANGED",
        });
        expect(warn).toHaveBeenCalledWith(
          "[HotUpdater] Automatic notifyAppReady analytics failed:",
          expect.any(Error),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
});

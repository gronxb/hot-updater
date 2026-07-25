import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(() => "1.2.3"),
  getBundleId: vi.fn(() => "bundle-current"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "cohort-a"),
  getFingerprintHash: vi.fn<() => string | null>(() => "fingerprint-a"),
  getInstallId: vi.fn(() => "install-a"),
  getPersistedUserIdentity: vi.fn(() => ({
    userId: "user-a",
    username: "Alice",
  })),
  setPersistedUserIdentity: vi.fn(),
}));

vi.mock("@hot-updater/react-native", () => ({
  HotUpdater: {
    getAppVersion: mocks.getAppVersion,
    getBundleId: mocks.getBundleId,
    getChannel: mocks.getChannel,
    getCohort: mocks.getCohort,
    getFingerprintHash: mocks.getFingerprintHash,
  },
}));

vi.mock("@hot-updater/react-native/internal/runtime-metadata", () => ({
  getInstallId: mocks.getInstallId,
  getPersistedUserIdentity: mocks.getPersistedUserIdentity,
  HOT_UPDATER_SDK_VERSION: "test-sdk",
  setPersistedUserIdentity: mocks.setPersistedUserIdentity,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

const loadClient = async () => {
  vi.resetModules();
  return import("./index");
};

const waitForSend = async (send: ReturnType<typeof vi.fn>) => {
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
};

describe("createReactNativeAnalytics payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      expected: {
        fromBundleId: "bundle-old",
        toBundleId: "bundle-new",
        type: "UPDATE_APPLIED",
        updateStrategy: "fingerprint",
      },
      result: {
        fromBundleId: "bundle-old",
        status: "UPDATE_APPLIED",
        toBundleId: "bundle-new",
        updateStrategy: "fingerprint",
      },
    },
    {
      expected: {
        fromBundleId: "bundle-bad",
        toBundleId: "bundle-restored",
        type: "RECOVERED",
        updateStrategy: "appVersion",
      },
      result: {
        fromBundleId: "bundle-bad",
        status: "RECOVERED",
        toBundleId: "bundle-restored",
        updateStrategy: "appVersion",
      },
    },
    {
      expected: {
        fromBundleId: null,
        toBundleId: "bundle-current",
        type: "UNCHANGED",
        updateStrategy: null,
      },
      result: { status: "UNCHANGED" },
    },
  ] as const)(
    "sends the canonical $expected.type event",
    async ({ expected, result }) => {
      // Given
      const send = vi.fn().mockResolvedValue(undefined);
      const { createReactNativeAnalytics } = await loadClient();
      const client = createReactNativeAnalytics({ transport: { send } });

      // When
      client.recordAppReady(result);
      await waitForSend(send);

      // Then
      expect(send).toHaveBeenCalledWith({
        appVersion: "1.2.3",
        channel: "production",
        cohort: "cohort-a",
        fingerprintHash: "fingerprint-a",
        installId: "install-a",
        platform: "ios",
        userId: "user-a",
        username: "Alice",
        ...expected,
      });
    },
  );

  it.each(["UPDATE_APPLIED", "RECOVERED"] as const)(
    "skips %s when updateStrategy is absent",
    async (status) => {
      // Given
      const send = vi.fn().mockResolvedValue(undefined);
      const { createReactNativeAnalytics } = await loadClient();
      const client = createReactNativeAnalytics({ transport: { send } });

      // When
      client.recordAppReady({
        fromBundleId: "bundle-old",
        status,
        toBundleId: "bundle-new",
      });
      await Promise.resolve();
      await Promise.resolve();

      // Then
      expect(send).not.toHaveBeenCalled();
      expect(mocks.getInstallId).not.toHaveBeenCalled();
    },
  );

  it("claims the runtime event before concurrent or repeated calls", async () => {
    // Given
    const send = vi.fn().mockResolvedValue(undefined);
    const { createReactNativeAnalytics } = await loadClient();
    const first = createReactNativeAnalytics({ transport: { send } });
    const second = createReactNativeAnalytics({ transport: { send } });

    // When
    first.recordAppReady({ status: "UNCHANGED" });
    second.recordAppReady({ status: "UNCHANGED" });
    first.recordAppReady({ status: "UNCHANGED" });
    await waitForSend(send);

    // Then
    expect(send).toHaveBeenCalledOnce();
  });

  it("delegates install and user identity operations", async () => {
    // Given
    const { createReactNativeAnalytics } = await loadClient();
    const client = createReactNativeAnalytics({
      transport: { send: vi.fn().mockResolvedValue(undefined) },
    });

    // When
    const installId = client.getInstallId();
    client.setUser({ userId: 42, username: "Alice" });
    client.setUser(null);

    // Then
    expect(installId).toBe("install-a");
    expect(mocks.setPersistedUserIdentity).toHaveBeenNthCalledWith(1, {
      userId: 42,
      username: "Alice",
    });
    expect(mocks.setPersistedUserIdentity).toHaveBeenNthCalledWith(2, null);
  });
});

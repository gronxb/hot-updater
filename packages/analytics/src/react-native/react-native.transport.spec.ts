import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(() => "1.2.3"),
  getBundleId: vi.fn(() => "bundle-current"),
  getChannel: vi.fn(() => "production"),
  getCohort: vi.fn(() => "cohort-a"),
  getFingerprintHash: vi.fn<() => string | null>(() => null),
  getInstallId: vi.fn(() => "install-a"),
  getPersistedUserIdentity: vi.fn(() => ({})),
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
  Platform: { OS: "android" },
}));

const loadClient = async () => {
  vi.resetModules();
  return import("./index");
};

describe("React Native analytics transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("copies caller headers and forces protocol headers", async () => {
    // Given
    const requestHeaders = {
      Authorization: "Bearer api-key",
      "Content-Type": "text/plain",
      "Hot-Updater-SDK-Version": "spoofed",
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const { createReactNativeAnalytics } = await loadClient();
    const client = createReactNativeAnalytics({
      baseURL: "https://updates.example/api/analytics/",
      requestHeaders,
    });
    requestHeaders.Authorization = "mutated";

    // When
    client.recordAppReady({ status: "UNCHANGED" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    // Then
    const [url, init] = fetch.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://updates.example/api/analytics/events");
    expect(headers.get("Authorization")).toBe("Bearer api-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Hot-Updater-SDK-Version")).toBe("test-sdk");
  });

  it("resolves a dynamic base URL for the attempted event", async () => {
    // Given
    const resolveBaseURL = vi.fn().mockResolvedValue("https://dynamic.test/a");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const { createReactNativeAnalytics } = await loadClient();
    const client = createReactNativeAnalytics({
      baseURL: resolveBaseURL,
    });

    // When
    client.recordAppReady({ status: "UNCHANGED" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    // Then
    expect(resolveBaseURL).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://dynamic.test/a/events",
      expect.any(Object),
    );
  });

  it.each([
    {
      fetchResult: () => Promise.resolve(new Response(null, { status: 200 })),
      label: "non-204 response",
    },
    {
      fetchResult: () => Promise.reject(new TypeError("network unavailable")),
      label: "network failure",
    },
  ])(
    "warns and reports a $label without sensitive data",
    async ({ fetchResult }) => {
      // Given
      const fetch = vi.fn().mockImplementation(fetchResult);
      const onError = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", fetch);
      const { createReactNativeAnalytics } = await loadClient();
      const client = createReactNativeAnalytics({
        baseURL: "https://updates.test/secret-path",
        onError,
        requestHeaders: { Authorization: "Bearer super-secret" },
      });

      // When
      client.recordAppReady({ status: "UNCHANGED" });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

      // Then
      expect(warn).toHaveBeenCalledWith(
        "[HotUpdater] Analytics event delivery failed.",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-path");
      warn.mockRestore();
    },
  );

  it("aborts a timed out request and reports it asynchronously", async () => {
    // Given
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const onError = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetch);
    const { createReactNativeAnalytics } = await loadClient();
    const client = createReactNativeAnalytics({
      baseURL: "https://updates.test",
      onError,
      requestTimeout: 10,
    });

    // When
    const returned = client.recordAppReady({ status: "UNCHANGED" });
    await vi.advanceTimersByTimeAsync(10);

    // Then
    expect(returned).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

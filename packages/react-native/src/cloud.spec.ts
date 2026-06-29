import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHotUpdaterCloudLifecycleNotifier } from "./cloud";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { ResolverNotifyAppReadyParams } from "./types";

vi.mock("./sdkVersion", () => ({
  HOT_UPDATER_SDK_VERSION: "test-sdk-version",
}));

const fetchMock = vi.fn<typeof fetch>();

const createParams = (
  params?: Partial<ResolverNotifyAppReadyParams>,
): ResolverNotifyAppReadyParams => ({
  bundleId: "bundle-id",
  channel: "production",
  eventId: "event-id",
  installId: "install-id",
  platform: "ios",
  requestHeaders: {
    Authorization: "Bearer deploy-token",
  },
  requestTimeout: 1000,
  status: "STABLE",
  ...params,
});

describe("createHotUpdaterCloudLifecycleNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date("2026-06-26T12:00:00.000Z"),
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts ACTIVE lifecycle telemetry to the HotUpdater Cloud runtime endpoint", async () => {
    const notifyAppReady = createHotUpdaterCloudLifecycleNotifier({
      baseURL: "https://runtime.example.com/p/prj_123/",
      telemetryKey: "hutk_publishable",
    });

    await notifyAppReady(createParams());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.example.com/p/prj_123/api/notify-app-ready",
      {
        body: JSON.stringify({
          bundleId: "bundle-id",
          channel: "production",
          eventId: "event-id",
          installId: "install-id",
          observedAt: "2026-06-26T12:00:00.000Z",
          platform: "ios",
          status: "ACTIVE",
        }),
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
          "x-hot-updater-telemetry-key": "hutk_publishable",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("posts RECOVERED telemetry with the crashed bundle id", async () => {
    const notifyAppReady = createHotUpdaterCloudLifecycleNotifier({
      baseURL: "https://runtime.example.com/p/prj_123",
      telemetryKey: "hutk_publishable",
    });

    await notifyAppReady(
      createParams({
        crashedBundleId: "crashed-bundle",
        status: "RECOVERED",
      }),
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe(
      JSON.stringify({
        bundleId: "bundle-id",
        channel: "production",
        crashedBundleId: "crashed-bundle",
        eventId: "event-id",
        installId: "install-id",
        observedAt: "2026-06-26T12:00:00.000Z",
        platform: "ios",
        status: "RECOVERED",
      }),
    );
  });

  it("resolves dynamic baseURL for each notify call", async () => {
    const resolveBaseURL = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://one.example.com/p/prj_123")
      .mockResolvedValueOnce("https://two.example.com/p/prj_123");
    const notifyAppReady = createHotUpdaterCloudLifecycleNotifier({
      baseURL: resolveBaseURL,
      telemetryKey: "hutk_publishable",
    });

    await notifyAppReady(createParams());
    await notifyAppReady(createParams());

    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://one.example.com/p/prj_123/api/notify-app-ready",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://two.example.com/p/prj_123/api/notify-app-ready",
    );
  });

  it("rejects non-publishable telemetry keys", () => {
    expect(() =>
      createHotUpdaterCloudLifecycleNotifier({
        baseURL: "https://runtime.example.com/p/prj_123",
        telemetryKey: "huc_secret",
      }),
    ).toThrow("telemetryKey must start with hutk_");
  });

  it("rejects telemetry keys without a suffix after the prefix", () => {
    expect(() =>
      createHotUpdaterCloudLifecycleNotifier({
        baseURL: "https://runtime.example.com/p/prj_123",
        telemetryKey: "hutk_",
      }),
    ).toThrow("telemetryKey must start with hutk_ and include a key suffix");
  });

  it("respects the request timeout when lifecycle telemetry hangs", async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError));
      });
    });
    const notifyAppReady = createHotUpdaterCloudLifecycleNotifier({
      baseURL: "https://runtime.example.com/p/prj_123",
      telemetryKey: "hutk_publishable",
    });

    const promise = notifyAppReady(createParams({ requestTimeout: 25 }));
    const assertion = expect(promise).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it("throws when the runtime rejects lifecycle telemetry", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const notifyAppReady = createHotUpdaterCloudLifecycleNotifier({
      baseURL: "https://runtime.example.com/p/prj_123",
      telemetryKey: "hutk_publishable",
    });

    await expect(notifyAppReady(createParams())).rejects.toThrow("Forbidden");
  });
});

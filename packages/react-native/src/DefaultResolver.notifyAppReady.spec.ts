import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultResolver } from "./DefaultResolver";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { ResolverNotifyAppReadyAnalyticsParams } from "./types";

const mocks = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };

  return { fetchUpdateInfo: vi.fn() };
});

vi.mock("./fetchUpdateInfo", () => ({
  fetchUpdateInfo: mocks.fetchUpdateInfo,
}));

const createNotifyParams = (
  type: "UPDATE_APPLIED" | "RECOVERED" = "UPDATE_APPLIED",
  updateStrategy: "fingerprint" | "appVersion" = "appVersion",
): ResolverNotifyAppReadyAnalyticsParams => {
  const common = {
    appVersion: "1.0.0",
    channel: "production",
    cohort: "cohort",
    fingerprintHash: null,
    fromBundleId: "bundle-a",
    installId: "install-id",
    platform: "ios" as const,
    requestHeaders: { Authorization: "Bearer token" },
    requestTimeout: 1500,
    toBundleId: "bundle-b",
    updateStrategy,
    userId: "user-123",
    username: "alice",
  };

  if (type === "RECOVERED") {
    return { ...common, type: "RECOVERED" };
  }

  return { ...common, type: "UPDATE_APPLIED" };
};

describe("createDefaultResolver.notifyAppReadyAnalytics", () => {
  beforeEach(() => {
    mocks.fetchUpdateInfo.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 204 }));
  });

  it("posts analytics to /events and requires HTTP 204", async () => {
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater///",
    );

    await resolver.notifyAppReadyAnalytics?.(
      createNotifyParams("RECOVERED", "fingerprint"),
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3007/hot-updater/events",
      {
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "cohort",
          fingerprintHash: null,
          fromBundleId: "bundle-a",
          installId: "install-id",
          platform: "ios",
          toBundleId: "bundle-b",
          type: "RECOVERED",
          updateStrategy: "fingerprint",
          userId: "user-123",
          username: "alice",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("posts UNCHANGED analytics with nullable transition fields", async () => {
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater///",
    );
    const unchangedParams = {
      appVersion: "1.0.0",
      channel: "production",
      cohort: "cohort",
      fingerprintHash: null,
      fromBundleId: null,
      installId: "install-id",
      platform: "ios",
      requestHeaders: { Authorization: "Bearer token" },
      requestTimeout: 1500,
      toBundleId: "bundle-id",
      type: "UNCHANGED",
      updateStrategy: null,
    } satisfies ResolverNotifyAppReadyAnalyticsParams;

    await resolver.notifyAppReadyAnalytics?.(unchangedParams);

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3007/hot-updater/events",
      expect.objectContaining({
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "cohort",
          fingerprintHash: null,
          fromBundleId: null,
          installId: "install-id",
          platform: "ios",
          toBundleId: "bundle-id",
          type: "UNCHANGED",
          updateStrategy: null,
        }),
        method: "POST",
      }),
    );
  });

  it("fails analytics when /events does not return HTTP 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const resolver = createDefaultResolver("http://localhost:3007/hot-updater");

    await expect(
      resolver.notifyAppReadyAnalytics?.(createNotifyParams()),
    ).rejects.toThrow("Expected HTTP 204 from /events, received 200");
  });
});

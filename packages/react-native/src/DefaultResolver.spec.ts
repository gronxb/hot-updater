// noqa: SIZE_OK - Existing resolver unit suite; splitting belongs to a dedicated test-structure cleanup.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultResolver } from "./DefaultResolver";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type {
  ResolverCheckUpdateParams,
  ResolverNotifyAppReadyParams,
} from "./types";

const mocks = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };

  return {
    fetchUpdateInfo: vi.fn(),
  };
});

vi.mock("./fetchUpdateInfo", () => ({
  fetchUpdateInfo: mocks.fetchUpdateInfo,
}));

const createParams = (
  params?: Partial<ResolverCheckUpdateParams>,
): ResolverCheckUpdateParams => ({
  appVersion: "1.0.0",
  bundleId: "bundle-id",
  channel: "production",
  cohort: "cohort",
  fingerprintHash: null,
  minBundleId: "min-bundle-id",
  platform: "ios",
  updateStrategy: "appVersion",
  ...params,
});

const createNotifyParams = (
  params?: Partial<ResolverNotifyAppReadyParams>,
): ResolverNotifyAppReadyParams => ({
  activeBundleId: "bundle-id",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "730",
  defaultChannel: "production",
  fingerprintHash: null,
  installId: "install-1",
  isChannelSwitched: false,
  platform: "ios",
  sdkVersion: HOT_UPDATER_SDK_VERSION,
  status: "STABLE",
  userId: null,
  ...params,
});

describe("createDefaultResolver", () => {
  beforeEach(() => {
    mocks.fetchUpdateInfo.mockReset();
    mocks.fetchUpdateInfo.mockResolvedValue(null);
    vi.unstubAllGlobals();
  });

  it("strips trailing slashes from baseURL for app-version requests", async () => {
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater/",
    );

    await resolver.checkUpdate?.(
      createParams({
        appVersion: "1.0",
        bundleId: "current-bundle",
        channel: "production",
        cohort: "730",
        minBundleId: "min-bundle",
        platform: "android",
      }),
    );

    expect(mocks.fetchUpdateInfo).toHaveBeenCalledWith({
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: undefined,
      url: "http://localhost:3007/hot-updater/app-version/android/1.0/production/min-bundle/current-bundle/730",
    });
  });

  it("strips trailing slashes from baseURL for fingerprint requests", async () => {
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater///",
    );

    await resolver.checkUpdate?.(
      createParams({
        appVersion: "1.0",
        bundleId: "current-bundle",
        channel: "beta",
        cohort: "qa",
        fingerprintHash: "fingerprint-hash",
        minBundleId: "min-bundle",
        platform: "ios",
        requestHeaders: { authorization: "Bearer token" },
        requestTimeout: 1500,
        updateStrategy: "fingerprint",
      }),
    );

    expect(mocks.fetchUpdateInfo).toHaveBeenCalledWith({
      requestHeaders: {
        authorization: "Bearer token",
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: 1500,
      url: "http://localhost:3007/hot-updater/fingerprint/ios/fingerprint-hash/beta/min-bundle/current-bundle/qa",
    });
  });

  it("keeps SDK version sync from leaving source changes behind", async () => {
    const sdkVersionPath = join(__dirname, "sdkVersion.ts");
    const before = await readFile(sdkVersionPath, "utf-8");
    const result = spawnSync(
      process.execPath,
      [join(__dirname, "../scripts/sync-sdk-version.mjs")],
      {
        cwd: join(__dirname, ".."),
        encoding: "utf-8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    await expect(readFile(sdkVersionPath, "utf-8")).resolves.toBe(before);
  });

  it("propagates fetchUpdateInfo errors", async () => {
    mocks.fetchUpdateInfo.mockRejectedValueOnce(new Error("Network failed"));
    const resolver = createDefaultResolver("http://localhost:3007/hot-updater");

    await expect(resolver.checkUpdate?.(createParams())).rejects.toThrow(
      "Network failed",
    );
  });

  it("resolves dynamic baseURL before checking for updates", async () => {
    const resolveBaseURL = vi.fn(async () => "https://updates.example.com");
    const resolver = createDefaultResolver(resolveBaseURL);

    await resolver.checkUpdate?.(createParams());

    expect(resolveBaseURL).toHaveBeenCalledWith();
    expect(mocks.fetchUpdateInfo).toHaveBeenCalledWith({
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: undefined,
      url: "https://updates.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
  });

  it("calls dynamic baseURL for each update check", async () => {
    const resolveBaseURL = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://one.example.com")
      .mockResolvedValueOnce("https://two.example.com");
    const resolver = createDefaultResolver(resolveBaseURL);

    await resolver.checkUpdate?.(createParams());
    await resolver.checkUpdate?.(createParams());

    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
    expect(mocks.fetchUpdateInfo).toHaveBeenNthCalledWith(1, {
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: undefined,
      url: "https://one.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
    expect(mocks.fetchUpdateInfo).toHaveBeenNthCalledWith(2, {
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: undefined,
      url: "https://two.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
  });

  it("strips trailing slashes from dynamic baseURL results", async () => {
    const resolver = createDefaultResolver(
      () => "https://updates.example.com/",
    );

    await resolver.checkUpdate?.(createParams());

    expect(mocks.fetchUpdateInfo).toHaveBeenCalledWith({
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
      requestTimeout: undefined,
      url: "https://updates.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
  });

  it("rejects an empty dynamic baseURL", async () => {
    const resolver = createDefaultResolver(() => "");

    await expect(resolver.checkUpdate?.(createParams())).rejects.toThrow(
      "baseURL resolver must return a non-empty string",
    );
  });

  it("posts app-ready events to the bundle-events endpoint", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater/",
    );

    await expect(
      resolver.notifyAppReady?.(
        createNotifyParams({
          crashedBundleId: "crashed-bundle",
          previousActiveBundleId: "crashed-bundle",
          requestHeaders: {
            authorization: "Bearer token",
          },
          requestTimeout: 1500,
          status: "RECOVERED",
        }),
      ),
    ).resolves.toEqual({
      crashedBundleId: "crashed-bundle",
      status: "RECOVERED",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3007/hot-updater/bundle-events/app-ready",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          authorization: "Bearer token",
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
        }),
        method: "POST",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Hot-Updater-Event-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(String(request.body))).toEqual({
      activeBundleId: "bundle-id",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "730",
      crashedBundleId: "crashed-bundle",
      defaultChannel: "production",
      fingerprintHash: null,
      installId: "install-1",
      isChannelSwitched: false,
      platform: "ios",
      previousActiveBundleId: "crashed-bundle",
      sdkVersion: HOT_UPDATER_SDK_VERSION,
      status: "RECOVERED",
      userId: null,
    });
  });

  it.each([404, 501])(
    "treats app-ready status %i as an unsupported no-op",
    async (status) => {
      // Given
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () => new Response(null, { status, statusText: "Unavailable" }));
      vi.stubGlobal("fetch", fetchMock);
      const resolver = createDefaultResolver(
        "http://localhost:3007/hot-updater",
      );

      // When
      const result = resolver.notifyAppReady?.(createNotifyParams());

      // Then
      await expect(result).resolves.toEqual({ status: "STABLE" });
    },
  );

  it("rejects app-ready server failures", async () => {
    // Given
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(null, {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolver = createDefaultResolver("http://localhost:3007/hot-updater");

    // When
    const result = resolver.notifyAppReady?.(createNotifyParams());

    // Then
    await expect(result).rejects.toThrow("Internal Server Error");
  });
});

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
  appVersion: "1.0.0",
  channel: "production",
  cohort: "cohort",
  fingerprintHash: null,
  fromBundleId: "bundle-a",
  installId: "install-id",
  platform: "ios",
  requestHeaders: {
    Authorization: "Bearer token",
  },
  requestTimeout: 1500,
  toBundleId: "bundle-b",
  type: "UPDATE_APPLIED",
  updateStrategy: "appVersion",
  ...params,
});

describe("createDefaultResolver", () => {
  beforeEach(() => {
    mocks.fetchUpdateInfo.mockReset();
    mocks.fetchUpdateInfo.mockResolvedValue(null);
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 204,
      }),
    );
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

  it("posts transition analytics to /events and requires HTTP 204", async () => {
    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater///",
    );

    await resolver.notifyAppReady?.(
      createNotifyParams({
        type: "RECOVERED",
        updateStrategy: "fingerprint",
        userId: "user-123",
        username: "alice",
      }),
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

  it("fails notifyAppReady when /events does not return HTTP 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
      }),
    );
    const resolver = createDefaultResolver("http://localhost:3007/hot-updater");

    await expect(
      resolver.notifyAppReady?.(createNotifyParams()),
    ).rejects.toThrow("Expected HTTP 204 from /events, received 200");
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
});

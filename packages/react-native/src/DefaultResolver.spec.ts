import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultResolver } from "./DefaultResolver";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { ResolverCheckUpdateParams } from "./types";

const mocks = vi.hoisted(() => ({
  fetchUpdateInfo: vi.fn(),
}));

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

describe("createDefaultResolver", () => {
  beforeEach(() => {
    mocks.fetchUpdateInfo.mockReset();
    mocks.fetchUpdateInfo.mockResolvedValue(null);
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

  it("keeps the SDK version header aligned with package.json", async () => {
    const [{ HOT_UPDATER_SDK_VERSION }, packageJson] = await Promise.all([
      import("./sdkVersion"),
      readFile(join(__dirname, "../package.json"), "utf-8"),
    ]);
    const pkg = JSON.parse(packageJson) as { version: string };

    expect(HOT_UPDATER_SDK_VERSION).toBe(pkg.version);
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

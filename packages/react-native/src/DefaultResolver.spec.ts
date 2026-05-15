import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultResolver } from "./DefaultResolver";
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

  it("resolves dynamic baseURL before checking for updates", async () => {
    const resolveBaseURL = vi.fn(async () => "https://updates.example.com");
    const resolver = createDefaultResolver(resolveBaseURL);

    await resolver.checkUpdate?.(createParams());

    expect(resolveBaseURL).toHaveBeenCalledWith();
    expect(mocks.fetchUpdateInfo).toHaveBeenCalledWith({
      requestHeaders: undefined,
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
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://one.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
    expect(mocks.fetchUpdateInfo).toHaveBeenNthCalledWith(2, {
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://two.example.com/app-version/ios/1.0.0/production/min-bundle-id/bundle-id/cohort",
    });
  });

  it("rejects an empty dynamic baseURL", async () => {
    const resolver = createDefaultResolver(() => "");

    await expect(resolver.checkUpdate?.(createParams())).rejects.toThrow(
      "baseURL resolver must return a non-empty string",
    );
  });
});

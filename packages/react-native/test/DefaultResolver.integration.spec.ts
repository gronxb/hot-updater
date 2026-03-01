import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultResolver } from "../src/DefaultResolver";
import { fetchUpdateInfo } from "../src/fetchUpdateInfo";
import type { ResolverCheckUpdateParams } from "../src/types";

vi.mock("../src/fetchUpdateInfo", () => ({
  fetchUpdateInfo: vi.fn(),
}));

describe("DefaultResolver OTA v2 integration", () => {
  const mockedFetchUpdateInfo = vi.mocked(fetchUpdateInfo);

  const baseParams: ResolverCheckUpdateParams = {
    platform: "ios",
    appVersion: "1.0.0",
    bundleId: "00000000-0000-0000-0000-000000000002",
    minBundleId: "00000000-0000-0000-0000-000000000001",
    channel: "production",
    updateStrategy: "appVersion",
    fingerprintHash: null,
    currentHash: "",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchUpdateInfo.mockResolvedValue(null);
  });

  it("adds currentHash query for app-version route, including empty string", async () => {
    const resolver = createDefaultResolver("https://example.com/hot-updater");

    await resolver.checkUpdate?.(baseParams);

    expect(mockedFetchUpdateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/hot-updater/app-version/ios/1.0.0/production/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002?currentHash=",
      }),
    );
  });

  it("omits currentHash query when value is null", async () => {
    const resolver = createDefaultResolver("https://example.com/hot-updater");

    await resolver.checkUpdate?.({
      ...baseParams,
      currentHash: null,
    });

    expect(mockedFetchUpdateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/hot-updater/app-version/ios/1.0.0/production/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002",
      }),
    );
  });

  it("adds currentHash query for fingerprint route", async () => {
    const resolver = createDefaultResolver("https://example.com/hot-updater");

    await resolver.checkUpdate?.({
      ...baseParams,
      updateStrategy: "fingerprint",
      fingerprintHash: "fp-123",
      currentHash: "abc123",
    });

    expect(mockedFetchUpdateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/hot-updater/fingerprint/ios/fp-123/production/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002?currentHash=abc123",
      }),
    );
  });
});

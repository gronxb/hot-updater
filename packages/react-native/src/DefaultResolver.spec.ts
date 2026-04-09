import { describe, expect, it, vi } from "vitest";

const { fetchUpdateInfoMock } = vi.hoisted(() => ({
  fetchUpdateInfoMock: vi.fn(),
}));

vi.mock("./fetchUpdateInfo", () => ({
  fetchUpdateInfo: fetchUpdateInfoMock,
}));

import { createDefaultResolver } from "./DefaultResolver";

describe("createDefaultResolver", () => {
  it("strips trailing slashes from baseURL for app-version requests", async () => {
    fetchUpdateInfoMock.mockResolvedValueOnce(null);

    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater/",
    );
    if (!resolver.checkUpdate) {
      throw new Error("Default resolver must implement checkUpdate");
    }

    await resolver.checkUpdate({
      appVersion: "1.0",
      bundleId: "current-bundle",
      channel: "production",
      cohort: "730",
      minBundleId: "min-bundle",
      platform: "android",
      requestHeaders: undefined,
      requestTimeout: undefined,
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });

    expect(fetchUpdateInfoMock).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "http://localhost:3007/hot-updater/app-version/android/1.0/production/min-bundle/current-bundle/730",
    });
  });

  it("strips trailing slashes from baseURL for fingerprint requests", async () => {
    fetchUpdateInfoMock.mockResolvedValueOnce(null);

    const resolver = createDefaultResolver(
      "http://localhost:3007/hot-updater///",
    );
    if (!resolver.checkUpdate) {
      throw new Error("Default resolver must implement checkUpdate");
    }

    await resolver.checkUpdate({
      appVersion: "1.0",
      bundleId: "current-bundle",
      channel: "beta",
      cohort: "qa",
      minBundleId: "min-bundle",
      platform: "ios",
      requestHeaders: { authorization: "Bearer token" },
      requestTimeout: 1500,
      updateStrategy: "fingerprint",
      fingerprintHash: "fingerprint-hash",
    });

    expect(fetchUpdateInfoMock).toHaveBeenCalledWith({
      requestHeaders: { authorization: "Bearer token" },
      requestTimeout: 1500,
      url: "http://localhost:3007/hot-updater/fingerprint/ios/fingerprint-hash/beta/min-bundle/current-bundle/qa",
    });
  });
});

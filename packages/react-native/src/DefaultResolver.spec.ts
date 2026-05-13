import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const { fetchUpdateInfoMock } = vi.hoisted(() => ({
  fetchUpdateInfoMock: vi.fn(),
}));

vi.mock("./fetchUpdateInfo", () => ({
  fetchUpdateInfo: fetchUpdateInfoMock,
}));

import { createDefaultResolver } from "./DefaultResolver";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";

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
      requestHeaders: {
        "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
      },
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
    fetchUpdateInfoMock.mockRejectedValueOnce(new Error("Network failed"));

    const resolver = createDefaultResolver("http://localhost:3007/hot-updater");
    if (!resolver.checkUpdate) {
      throw new Error("Default resolver must implement checkUpdate");
    }

    await expect(
      resolver.checkUpdate({
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
      }),
    ).rejects.toThrow("Network failed");
  });
});

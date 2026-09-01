import { beforeEach, describe, expect, it, vi } from "vitest";

import { getChannel } from "./setChannel";

const androidGet = vi.fn();
const androidExists = vi.fn();
const iosGet = vi.fn();
const iosExists = vi.fn();

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: vi.fn(async () => ({
    platform: {
      android: { androidManifestPaths: [], stringResourcePaths: [] },
      ios: { infoPlistPaths: [] },
    },
  })),
}));

vi.mock("./configParser/androidParser", () => ({
  AndroidConfigParser: class {
    exists = androidExists;
    get = androidGet;
  },
}));

vi.mock("./configParser/iosParser", () => ({
  IosConfigParser: class {
    exists = iosExists;
    get = iosGet;
  },
}));

describe("getChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    androidExists.mockResolvedValue(true);
    iosExists.mockResolvedValue(true);
  });

  it("falls back to the native default channel when Android has none", async () => {
    androidGet.mockResolvedValue({
      value: null,
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });

    await expect(getChannel("android")).resolves.toEqual({
      value: "production",
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });
  });

  it("falls back to the native default channel when iOS has none", async () => {
    iosGet.mockResolvedValue({
      value: null,
      paths: ["ios/HotUpdaterExample/Info.plist"],
    });

    await expect(getChannel("ios")).resolves.toEqual({
      value: "production",
      paths: ["ios/HotUpdaterExample/Info.plist"],
    });
  });

  it("returns the configured channel when one is set", async () => {
    androidGet.mockResolvedValue({
      value: "staging",
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });

    await expect(getChannel("android")).resolves.toEqual({
      value: "staging",
      paths: ["android/app/src/main/AndroidManifest.xml"],
    });
  });
});

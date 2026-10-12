import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const createFingerprintAsync = vi.hoisted(() => vi.fn());

vi.mock("@expo/fingerprint", () => ({
  createFingerprintAsync,
  SourceSkips: {
    GitIgnore: 1,
    PackageJsonScriptsAll: 2,
    PackageJsonAndroidAndIosScriptsIfNotContainRun: 4,
    ExpoConfigAll: 8,
    ExpoConfigVersions: 16,
    ExpoConfigNames: 32,
    ExpoConfigRuntimeVersionIfString: 64,
    ExpoConfigAssets: 128,
    ExpoConfigExtraSection: 256,
    ExpoConfigEASProject: 512,
    ExpoConfigSchemes: 1024,
  },
}));

import { createExpoFingerprint } from "./fingerprint";

describe("Expo fingerprint policy", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("owns Expo discovery and forwards platform-specific extra sources", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-fingerprint-"));
    directories.push(cwd);
    await fs.mkdir(path.join(cwd, "ios"));
    await fs.writeFile(path.join(cwd, "ios", "native.xcconfig"), "VALUE=1");
    const expected = { hash: "fingerprint", sources: [] };
    createFingerprintAsync.mockResolvedValue(expected);

    await expect(
      createExpoFingerprint(cwd, {
        platform: "ios",
        extraSources: {
          ios: ["ios/native.xcconfig"],
          android: ["android/native.properties"],
        },
      }),
    ).resolves.toBe(expected);

    expect(createFingerprintAsync).toHaveBeenCalledWith(
      cwd,
      expect.objectContaining({
        platforms: ["ios"],
        useRNCoreAutolinkingFromExpo: true,
        extraSources: [
          expect.objectContaining({
            id: "ios/native.xcconfig",
            type: "contents",
          }),
        ],
      }),
    );
  });
});

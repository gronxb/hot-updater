import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReactNativeFingerprint } from "./buildFingerprint";

describe("React Native native fingerprint", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-rn-fingerprint-"),
    );
    await fs.mkdir(path.join(cwd, "ios/App"), { recursive: true });
    await fs.mkdir(path.join(cwd, "android/app"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "react-native": "0.85.0" } }),
    );
    await fs.writeFile(path.join(cwd, "ios/App/App.swift"), "ios-v1");
    await fs.writeFile(path.join(cwd, "android/app/Main.kt"), "android-v1");
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("changes only the affected platform fingerprint for native source edits", async () => {
    const iosBefore = await createReactNativeFingerprint(cwd, {
      platform: "ios",
    });
    const androidBefore = await createReactNativeFingerprint(cwd, {
      platform: "android",
    });

    await fs.writeFile(path.join(cwd, "ios/App/App.swift"), "ios-v2");

    const iosAfter = await createReactNativeFingerprint(cwd, {
      platform: "ios",
    });
    const androidAfter = await createReactNativeFingerprint(cwd, {
      platform: "android",
    });
    expect(iosAfter.hash).not.toBe(iosBefore.hash);
    expect(androidAfter.hash).toBe(androidBefore.hash);
    expect(
      iosAfter.sources.map((source) =>
        "filePath" in source ? source.filePath : source.id,
      ),
    ).toEqual(["ios/App/App.swift", "package.json"]);
  });

  it("includes configured extra sources", async () => {
    await fs.writeFile(path.join(cwd, "native-profile.json"), "profile-v1");
    const before = await createReactNativeFingerprint(cwd, {
      platform: "ios",
      extraSources: ["native-profile.json"],
    });
    await fs.writeFile(path.join(cwd, "native-profile.json"), "profile-v2");
    const after = await createReactNativeFingerprint(cwd, {
      platform: "ios",
      extraSources: ["native-profile.json"],
    });

    expect(after.hash).not.toBe(before.hash);
  });

  it.skipIf(process.platform === "win32")(
    "changes when a symlinked native config target inside the app changes",
    async () => {
      const target = path.join(cwd, "shared-native-config.xcconfig");
      await fs.writeFile(target, "SETTING=v1");
      await fs.symlink(
        target,
        path.join(cwd, "ios/App/Config.xcconfig"),
        "file",
      );
      const before = await createReactNativeFingerprint(cwd, {
        platform: "ios",
      });

      await fs.writeFile(target, "SETTING=v2");

      const after = await createReactNativeFingerprint(cwd, {
        platform: "ios",
      });
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows an in-root directory symlink nested under an extra source",
    async () => {
      await fs.mkdir(path.join(cwd, "config"));
      await fs.mkdir(path.join(cwd, "shared"));
      const target = path.join(cwd, "shared/native.json");
      await fs.writeFile(target, "native-v1");
      await fs.symlink("../shared", path.join(cwd, "config/linked"), "dir");
      const before = await createReactNativeFingerprint(cwd, {
        platform: "ios",
        extraSources: ["config"],
      });

      await fs.writeFile(target, "native-v2");

      const after = await createReactNativeFingerprint(cwd, {
        platform: "ios",
        extraSources: ["config"],
      });
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it("uses locale-independent Unicode source ordering", async () => {
    await Promise.all([
      fs.writeFile(path.join(cwd, "ios/App/Z.swift"), "upper"),
      fs.writeFile(path.join(cwd, "ios/App/ä.swift"), "non-ascii"),
    ]);

    const fingerprint = await createReactNativeFingerprint(cwd, {
      platform: "ios",
    });

    expect(
      fingerprint.sources.map((source) =>
        "filePath" in source ? source.filePath : source.id,
      ),
    ).toEqual([
      "ios/App/App.swift",
      "ios/App/Z.swift",
      "ios/App/ä.swift",
      "package.json",
    ]);
  });
});

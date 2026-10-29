import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { linesWiderThan, renderClackLog } from "@hot-updater/test-utils/node";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
}));

import type { NativeBuildResult } from "./createNativeBuild";
import {
  formatNativeBuildSummary,
  readArtifactSize,
} from "./nativeBuildSummary";

const ipa: NativeBuildResult = {
  platform: "ios",
  scheme: "release",
  minBundleId: "019a2f0c-1d2e-7000-8000-0000000000c1",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.7.0",
  artifactPath: "/project/.hot-updater/build/ios/release/export/CodexRelay.ipa",
  artifactKind: "ipa",
  buildNumber: "42",
};

const summary = (
  overrides: Partial<Parameters<typeof formatNativeBuildSummary>[0]>,
) =>
  stripVTControlCharacters(
    formatNativeBuildSummary({
      platformName: "iOS",
      result: ipa,
      reused: false,
      elapsedMs: 510_000,
      byteSize: 48 * 1024 * 1024,
      logFilePath: "/project/.hot-updater/log/10291132-ios-release-build.log",
      ...overrides,
    }),
  );

describe("formatNativeBuildSummary", () => {
  it("names the build, its artifact and size, and its log, under one heading", () => {
    expect(summary({}).split("\n")).toEqual([
      "iOS release 1.7.0 (42) built in 8m30s",
      "IPA            .hot-updater/build/ios/release/export/CodexRelay.ipa · 48.0 MB",
      "Min bundle ID  019a2f0c-1d2e-7000-8000-0000000000c1",
      "Channel        production",
      "Log            .hot-updater/log/10291132-ios-release-build.log",
    ]);
  });

  it("says a reused build was reused, without a log, and with its store page", () => {
    expect(
      summary({
        reused: true,
        elapsedMs: 4_100,
        logFilePath: null,
        storeUrl: "https://appstoreconnect.apple.com/apps/1/testflight/ios",
      }).split("\n"),
    ).toEqual([
      "iOS release 1.7.0 (42) reused in 4.1s",
      "IPA            .hot-updater/build/ios/release/export/CodexRelay.ipa · 48.0 MB",
      "Min bundle ID  019a2f0c-1d2e-7000-8000-0000000000c1",
      "Channel        production",
      "Open           https://appstoreconnect.apple.com/apps/1/testflight/ios",
    ]);
  });

  it("names a fingerprint build's fingerprint, and leaves out what it can't read", () => {
    const lines = summary({
      platformName: "Android",
      result: {
        ...ipa,
        platform: "android",
        fingerprintHash: "3f2a9c1e5b7d",
        appVersion: null,
        artifactKind: "aab",
        artifactPath:
          "/project/android/app/build/outputs/bundle/release/app-release.aab",
        buildNumber: null,
      },
      byteSize: null,
    }).split("\n");

    expect(lines[0]).toBe("Android release built in 8m30s");
    expect(lines[1]).toBe(
      "AAB            android/app/build/outputs/bundle/release/app-release.aab",
    );
    expect(lines[2]).toBe("Fingerprint    3f2a9c1e5b7d");
  });

  it("shortens a long path so no line wraps on 80 columns", () => {
    const text = summary({
      result: {
        ...ipa,
        artifactPath: `/project/${"very-long-directory/".repeat(6)}CodexRelay.ipa`,
      },
    });

    expect(linesWiderThan(renderClackLog([["success", text]]))).toEqual([]);
    expect(text).toContain("…/CodexRelay.ipa · 48.0 MB");
  });
});

describe("readArtifactSize", () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads a file's size, a directory's files' sum, and null for none", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-size-"));
    await fs.writeFile(path.join(dir, "app.apk"), "x".repeat(10));
    await fs.mkdir(path.join(dir, "App.app", "Frameworks"), {
      recursive: true,
    });
    await fs.writeFile(path.join(dir, "App.app", "App"), "x".repeat(5));
    await fs.writeFile(path.join(dir, "App.app", "Frameworks", "A"), "xxx");

    expect(await readArtifactSize(path.join(dir, "app.apk"))).toBe(10);
    expect(await readArtifactSize(path.join(dir, "App.app"))).toBe(8);
    expect(await readArtifactSize(path.join(dir, "missing.ipa"))).toBeNull();
  });
});

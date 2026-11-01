import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

const { getChannel, warn } = vi.hoisted(() => ({
  getChannel: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => root,
  p: { log: { warn, info: vi.fn() } },
}));
vi.mock("@hot-updater/apple-helper", () => ({
  archiveAppBundle: vi.fn(),
  assertSandboxExportOptions: vi.fn(async (scheme: string, file: string) => {
    if (fs.readFileSync(file, "utf-8").includes("<false/>")) {
      throw new Error(`The sandbox scheme ${scheme} refused.`);
    }
  }),
}));
vi.mock("@hot-updater/android-helper", () => ({
  findSandboxGradleBlocker: vi.fn(() => null),
}));
vi.mock("../setChannel", () => ({ getChannel }));
vi.mock("../fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fingerprint")>()),
  ensureFingerprintConfig: vi.fn(async () => ({})),
  getFingerprintDiff: vi.fn(async () => []),
  readLocalFingerprint: vi.fn(async () => ({ android: { sources: [] } })),
}));

import { findSandboxGradleBlocker } from "@hot-updater/android-helper";

import { getFingerprintDiff } from "../fingerprint";
import {
  assertBuiltArtifact,
  assertSandboxBuildAllowed,
  usesSwiftPackageManager,
} from "./sandbox";

// Made by the protocol package's __fixtures__/generate.sh with d8, aapt2, clang
// and plutil: the oracle these checks read.
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../protocol/src/nativeArtifact/__fixtures__",
);
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const FINGERPRINT =
  "5de1cdbfefdc1f0b4a1b3c36ed83c246dff317dd540c0393ca76fa758026ec8f";

const writeZip = async (name: string, files: Record<string, Uint8Array>) => {
  const archive = new JSZip();
  for (const [entry, content] of Object.entries(files)) {
    archive.file(entry, content);
  }
  const file = path.join(root, name);
  fs.writeFileSync(file, await archive.generateAsync({ type: "uint8array" }));
  return file;
};

const apk = (manifest: string, dex: string) =>
  writeZip("app.apk", {
    "AndroidManifest.xml": fixture(manifest),
    "classes.dex": fixture(dex),
    "assets/index.android.bundle": new TextEncoder().encode("bundle"),
  });
const ipa = (plist: string, executable: string) =>
  writeZip("App.ipa", {
    "Payload/App.app/Info.plist": fixture(plist),
    "Payload/App.app/App": fixture(executable),
    "Payload/App.app/main.jsbundle": new TextEncoder().encode("bundle"),
  });

const android = { packageName: "com.example" };
const ios = { bundleIdentifier: "com.example", scheme: "App" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-"));
  vi.clearAllMocks();
  getChannel.mockResolvedValue({ value: "production", paths: [] });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assertSandboxBuildAllowed", () => {
  it("lets a normal scheme build on any channel but a reserved one", async () => {
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "release",
        androidScheme: android,
      }),
    ).resolves.toBeUndefined();

    getChannel.mockResolvedValue({ value: "sandbox-beta", paths: [] });
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "release",
        androidScheme: android,
      }),
    ).rejects.toThrow(
      "Channel sandbox-beta is reserved for sandbox builds, and the scheme release isn't one.\nSet sandbox: true on it, or run:\nnpx hot-updater channel set production",
    );
  });

  it("lets a normal scheme through when no native project exists yet", async () => {
    getChannel.mockRejectedValue(new Error("No Android native config files"));
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "release",
        androidScheme: android,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["ios", { ...ios, sandbox: true, configuration: "Debug" }, "Debug"],
    [
      "android",
      { ...android, sandbox: true, variant: "stagingDebug" },
      "stagingDebug",
    ],
  ] as const)(
    "refuses a %s sandbox scheme that builds Debug",
    async (platform, scheme, type) => {
      await expect(
        assertSandboxBuildAllowed({
          platform,
          scheme: "beta",
          ...(platform === "ios"
            ? { iosScheme: scheme as never }
            : { androidScheme: scheme as never }),
        }),
      ).rejects.toThrow(
        `The sandbox scheme beta builds ${type}, which skips OTA updates.\nBuild a release configuration.`,
      );
    },
  );

  it("refuses a scheme whose name can't make a channel", async () => {
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "my scheme",
        androidScheme: { ...android, sandbox: true },
      }),
    ).rejects.toThrow("can't name a channel");
  });

  it("keeps each platform to its internal store", async () => {
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "beta",
        androidScheme: { ...android, sandbox: true },
        submit: "play-internal",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSandboxBuildAllowed({
        platform: "ios",
        scheme: "beta",
        iosScheme: { ...ios, sandbox: true },
        submit: "testflight",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "beta",
        androidScheme: { ...android, sandbox: true },
        submit: "testflight",
      }),
    ).rejects.toThrow(
      "A sandbox build can't go to testflight.\nUse play-internal.",
    );
  });

  it("refuses Swift Package Manager before any work", async () => {
    const project = path.join(root, "ios/App.xcodeproj/project.pbxproj");
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.writeFileSync(
      project,
      'A /* XCLocalSwiftPackageReference "build/generated/autolinking" */ = {isa = XCLocalSwiftPackageReference;};',
    );
    await expect(
      assertSandboxBuildAllowed({
        platform: "ios",
        scheme: "beta",
        iosScheme: { ...ios, sandbox: true },
      }),
    ).rejects.toThrow(
      "The sandbox scheme beta builds with Swift Package Manager, which sandbox builds don't support yet.\nBuild with CocoaPods, or remove sandbox: true.",
    );
  });

  it("refuses export options that turn internal testing off", async () => {
    fs.writeFileSync(path.join(root, "Export.plist"), "<false/>");
    await expect(
      assertSandboxBuildAllowed({
        platform: "ios",
        scheme: "beta",
        iosScheme: {
          ...ios,
          sandbox: true,
          exportOptionsPlist: "Export.plist",
        },
      }),
    ).rejects.toThrow("The sandbox scheme beta refused.");
  });

  it("refuses what Gradle couldn't build", async () => {
    vi.mocked(findSandboxGradleBlocker).mockReturnValueOnce(
      "Blocked.\nFix it.",
    );
    await expect(
      assertSandboxBuildAllowed({
        platform: "android",
        scheme: "beta",
        androidScheme: { ...android, sandbox: true },
      }),
    ).rejects.toThrow("Blocked.\nFix it.");
  });
});

describe("usesSwiftPackageManager", () => {
  const examples = path.resolve(import.meta.dirname, "../../../../../examples");

  it("tells React Native's SwiftPM project from a CocoaPods one", () => {
    expect(
      usesSwiftPackageManager(path.join(examples, "v0.87.1-spm/ios")),
    ).toBe(true);
    expect(usesSwiftPackageManager(path.join(examples, "v0.88.0/ios"))).toBe(
      false,
    );
    expect(usesSwiftPackageManager(path.join(root, "no-ios"))).toBe(false);
  });
});

describe("assertBuiltArtifact", () => {
  const sandboxBuild = {
    platform: "android",
    scheme: "release",
    sandbox: true,
    channel: "sandbox-release",
    fingerprintHash: FINGERPRINT,
  } as const;
  const normalBuild = {
    platform: "android",
    scheme: "release",
    sandbox: false,
    channel: "beta",
    fingerprintHash: FINGERPRINT,
  } as const;

  it("accepts a sandbox .apk and .ipa with the layer whole, on their channel, with the fingerprint", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        artifactPath: await apk("sandbox.axml", "sandbox.dex"),
      }),
    ).resolves.toMatchObject({ sandbox: { code: true, declared: true } });
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        platform: "ios",
        artifactPath: await ipa("Info.sandbox.plist", "App-sandbox"),
      }),
    ).resolves.toMatchObject({ sandbox: { code: true, declared: true } });
  });

  it("accepts a normal .apk with none of the layer", async () => {
    await expect(
      assertBuiltArtifact({
        ...normalBuild,
        artifactPath: await apk("release.axml", "classes.dex"),
      }),
    ).resolves.toMatchObject({ sandbox: { code: false, declared: false } });
  });

  it("refuses a sandbox build that lost the layer's code, as stale pods do", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        platform: "ios",
        artifactPath: await ipa("Info.sandbox.plist", "App"),
      }),
    ).rejects.toThrow(
      "The sandbox scheme release built without the sandbox layer.\nRun pod install, then build again.",
    );
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        artifactPath: await apk("release.axml", "classes.dex"),
      }),
    ).rejects.toThrow(
      "The sandbox scheme release built without the sandbox layer.\nUpdate @hot-updater/react-native, then build again.",
    );
  });

  it("refuses a sandbox build whose code is there, but whose manifest entry isn't", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        artifactPath: await apk("release.axml", "sandbox.dex"),
      }),
    ).rejects.toThrow("has the sandbox layer's code, but no sandbox");
  });

  it("refuses a sandbox build on another scheme's channel", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        scheme: "beta",
        artifactPath: await apk("sandbox.axml", "sandbox.dex"),
      }),
    ).rejects.toThrow(
      "The sandbox scheme beta built channel sandbox-release, not sandbox-beta.",
    );
  });

  it("refuses a normal build that holds the layer, saying what brought it in", async () => {
    await expect(
      assertBuiltArtifact({
        ...normalBuild,
        artifactPath: await apk("release.axml", "sandbox.dex"),
      }),
    ).rejects.toThrow(
      "The scheme release isn't a sandbox scheme, but its build holds the sandbox layer.\nRemove hotUpdaterSandbox from gradle.properties.",
    );
    await expect(
      assertBuiltArtifact({
        ...normalBuild,
        platform: "ios",
        artifactPath: await ipa("Info.plist", "App-sandbox"),
      }),
    ).rejects.toThrow(
      "Remove HOT_UPDATER_SANDBOX_LAYER from the project's build settings.",
    );
  });

  it("refuses a normal build on a reserved channel", async () => {
    await expect(
      assertBuiltArtifact({
        ...normalBuild,
        channel: "sandbox-beta",
        artifactPath: await apk("release.axml", "classes.dex"),
      }),
    ).rejects.toThrow(
      "Channel sandbox-beta is reserved for sandbox builds, and the .apk isn't one.",
    );
  });

  it("refuses a sandbox build whose embedded fingerprint isn't a normal build's", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        fingerprintHash: "a".repeat(64),
        artifactPath: await apk("sandbox.axml", "sandbox.dex"),
      }),
    ).rejects.toThrow(
      `The sandbox build embeds fingerprint ${FINGERPRINT}; a normal build has ${"a".repeat(64)}.`,
    );
  });

  it("names what an extraSources pattern saw change during the build", async () => {
    vi.mocked(getFingerprintDiff).mockResolvedValueOnce([
      {
        op: "added",
        addedSource: {
          type: "file",
          filePath: "android/app/build/merged.xml",
          reasons: ["extraSources"],
          hash: "x",
        },
      },
    ] as never);
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        fingerprintHash: "a".repeat(64),
        artifactPath: await apk("sandbox.axml", "sandbox.dex"),
      }),
    ).rejects.toThrow(
      "Changed during the build: android/app/build/merged.xml\nPoint fingerprint.extraSources at source files, not at what a build writes.",
    );
  });

  it("skips the fingerprint under the appVersion strategy", async () => {
    await expect(
      assertBuiltArtifact({
        ...sandboxBuild,
        fingerprintHash: null,
        artifactPath: await apk("sandbox.axml", "sandbox.dex"),
      }),
    ).resolves.not.toBeNull();
  });

  it("warns on a normal build it can't read, and fails a sandbox build", async () => {
    const artifactPath = path.join(root, "missing.apk");
    await expect(
      assertBuiltArtifact({ ...normalBuild, artifactPath }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't check the build"),
    );
    await expect(
      assertBuiltArtifact({ ...sandboxBuild, artifactPath }),
    ).rejects.toThrow("Couldn't check the sandbox build.");
  });
});

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", () => ({
  p: { log: { info: vi.fn() } },
}));
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({
    stdout: JSON.stringify([
      {
        target: "App",
        buildSettings: {
          TARGET_BUILD_DIR: "/derived/Build",
          INFOPLIST_PATH: "App.app/Info.plist",
          EXECUTABLE_FOLDER_PATH: "App.app",
          FULL_PRODUCT_NAME: "App.app",
          WRAPPER_EXTENSION: "app",
        },
      },
    ]),
  })),
}));
vi.mock("../utils/parseXcodeProjectInfo", () => ({
  parseXcodeProjectInfo: async () => ({
    name: "App.xcworkspace",
    isWorkspace: true,
  }),
}));
vi.mock("../utils/createRandomTmpDir", () => ({
  createRandomTmpDir: async () => "/tmp/build",
}));
vi.mock("../utils/runXcodebuildWithLogging", () => ({
  runXcodebuildWithLogging: vi.fn(),
}));

import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";
import { archiveXcodeProject } from "./archiveXcodeProject";
import { buildXcodeProject } from "./buildXcodeProject";
import { exportXcodeArchive } from "./exportXcodeArchive";

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5";
const AUTHENTICATION_ARGS = [
  "-allowProvisioningUpdates",
  "-authenticationKeyPath",
  "/tmp/AuthKey_ABC.p8",
  "-authenticationKeyID",
  "ABC",
  "-authenticationKeyIssuerID",
  "issuer",
];

const xcodebuildCall = () =>
  vi.mocked(runXcodebuildWithLogging).mock.calls[0]![0];

const writeFile = vi.spyOn(fs.promises, "writeFile");

beforeEach(() => {
  vi.mocked(runXcodebuildWithLogging).mockClear();
  writeFile.mockReset().mockResolvedValue(undefined);
});

const BUILD_XCCONFIG = "/tmp/build/HotUpdater.xcconfig";
// Clears a target's manual profile and identity, which Xcode would report as
// conflicting with automatic signing.
const AUTOMATIC_SIGNING = `CODE_SIGN_STYLE = Automatic
PROVISIONING_PROFILE = 
PROVISIONING_PROFILE[sdk=iphoneos*] = 
PROVISIONING_PROFILE_SPECIFIER = 
PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*] = 
CODE_SIGN_IDENTITY = Apple Development
CODE_SIGN_IDENTITY[sdk=iphoneos*] = Apple Development
`;

describe("xcodebuild arguments", () => {
  it("archives with the MIN_BUNDLE_ID as a build setting and in the environment, and with the signing arguments", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      platform: "ios",
      installPods: false,
      xcodeScheme: "App",
      logPrefix: "ios-release-build-archive",
      minBundleId: MIN_BUNDLE_ID,
      authenticationArgs: AUTHENTICATION_ARGS,
    });

    const { args, env } = xcodebuildCall();
    expect(args).toContain(`HOT_UPDATER_MIN_BUNDLE_ID=${MIN_BUNDLE_ID}`);
    expect(env).toEqual({ HOT_UPDATER_MIN_BUNDLE_ID: MIN_BUNDLE_ID });
    expect(args.join(" ")).toContain(AUTHENTICATION_ARGS.join(" "));
    // The key signs a target set to manual signing automatically too.
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `HOT_UPDATER_MIN_BUNDLE_ID = ${MIN_BUNDLE_ID}\n${AUTOMATIC_SIGNING}`,
    );
  });

  it("sets the MIN_BUNDLE_ID and automatic signing over the scheme's xcconfig and the ones in extraParams, which outrank the command line", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      platform: "ios",
      installPods: false,
      xcodeScheme: "App",
      xcconfig: "Release.xcconfig",
      extraParams: ["-quiet", "-xcconfig", "/configs/Manual.xcconfig"],
      logPrefix: "ios-release-build-archive",
      minBundleId: MIN_BUNDLE_ID,
      authenticationArgs: AUTHENTICATION_ARGS,
    });

    const { args } = xcodebuildCall();
    expect(args.filter((arg) => arg === "-xcconfig")).toHaveLength(1);
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    expect(args).toContain("-quiet");
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `#include "/app/ios/Release.xcconfig"\n#include "/configs/Manual.xcconfig"\nHOT_UPDATER_MIN_BUNDLE_ID = ${MIN_BUNDLE_ID}\n${AUTOMATIC_SIGNING}`,
    );
  });

  it("sets only the MIN_BUNDLE_ID over the scheme's xcconfig when it signs without an App Store Connect API key", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      platform: "ios",
      installPods: false,
      xcodeScheme: "App",
      xcconfig: "Release.xcconfig",
      logPrefix: "ios-release-build-archive",
      minBundleId: MIN_BUNDLE_ID,
    });

    const { args } = xcodebuildCall();
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    // An xcconfig that sets HOT_UPDATER_MIN_BUNDLE_ID cannot replace it.
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `#include "/app/ios/Release.xcconfig"\nHOT_UPDATER_MIN_BUNDLE_ID = ${MIN_BUNDLE_ID}\n`,
    );
  });

  it("exports with the signing arguments", async () => {
    await exportXcodeArchive({
      archivePath: "/tmp/App.xcarchive",
      sourceDir: "/app/ios",
      exportOptionsPlist: "/tmp/ExportOptions.plist",
      logPrefix: "ios-release-build-export",
      authenticationArgs: AUTHENTICATION_ARGS,
    });

    const { args } = xcodebuildCall();
    expect(args.slice(0, 5)).toEqual([
      "-exportArchive",
      "-archivePath",
      "/tmp/App.xcarchive",
      "-exportPath",
      "/tmp/build",
    ]);
    expect(args.join(" ")).toContain(AUTHENTICATION_ARGS.join(" "));
    expect(args.slice(-2)).toEqual([
      "-exportOptionsPlist",
      "/tmp/ExportOptions.plist",
    ]);
    // -exportArchive takes no build settings.
    expect(args).not.toContain("-xcconfig");
  });

  it("builds without signing arguments unless it is given them", async () => {
    await buildXcodeProject({
      sourceDir: "/app/ios",
      platform: "ios",
      xcodeScheme: "App",
      configuration: "Release",
      deviceType: "simulator",
      logPrefix: "ios-debug-build",
      useGenericDestination: true,
      minBundleId: MIN_BUNDLE_ID,
    });

    const { args, env } = xcodebuildCall();
    expect(args).toContain(`HOT_UPDATER_MIN_BUNDLE_ID=${MIN_BUNDLE_ID}`);
    expect(env).toEqual({ HOT_UPDATER_MIN_BUNDLE_ID: MIN_BUNDLE_ID });
    expect(args).not.toContain("-allowProvisioningUpdates");
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `HOT_UPDATER_MIN_BUNDLE_ID = ${MIN_BUNDLE_ID}\n`,
    );
  });

  it("builds a device app that signs with a key with automatic signing over the xcconfigs in extraParams", async () => {
    await buildXcodeProject({
      sourceDir: "/app/ios",
      platform: "ios",
      xcodeScheme: "App",
      configuration: "Release",
      deviceType: "device",
      logPrefix: "ios-release-run",
      destination: [{ id: "device-udid" }],
      extraParams: ["-xcconfig", "Manual.xcconfig"],
      minBundleId: MIN_BUNDLE_ID,
      authenticationArgs: AUTHENTICATION_ARGS,
    });

    const { args } = xcodebuildCall();
    expect(args.filter((arg) => arg === "-xcconfig")).toHaveLength(1);
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `#include "/app/ios/Manual.xcconfig"\nHOT_UPDATER_MIN_BUNDLE_ID = ${MIN_BUNDLE_ID}\n${AUTOMATIC_SIGNING}`,
    );
  });
});

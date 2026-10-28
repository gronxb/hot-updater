import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  BuildFailedError: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).BuildFailedError,
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
  removeTmpDir: vi.fn(),
}));
vi.mock("../utils/runXcodebuildWithLogging", () => ({
  runXcodebuildWithLogging: vi.fn(),
}));

import { removeTmpDir } from "../utils/createRandomTmpDir";
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
// The built .app copied out of DerivedData.
const cp = vi.spyOn(fs.promises, "cp");

beforeEach(() => {
  vi.mocked(runXcodebuildWithLogging).mockReset();
  vi.mocked(removeTmpDir).mockClear();
  writeFile.mockReset().mockResolvedValue(undefined);
  cp.mockReset().mockResolvedValue(undefined);
});

const BUILD_XCCONFIG = "/tmp/build/HotUpdater.xcconfig";
/** Each setting, for every SDK and for the device and simulator SDKs. */
const settings = (values: Record<string, string>) =>
  Object.entries(values)
    .flatMap(([key, value]) =>
      ["", "[sdk=iphoneos*]", "[sdk=iphonesimulator*]"].map(
        (condition) => `${key}${condition} = ${value}\n`,
      ),
    )
    .join("");
// Clears a target's manual profile and identity, which Xcode would report as
// conflicting with automatic signing.
const AUTOMATIC_SIGNING = settings({
  CODE_SIGN_STYLE: "Automatic",
  PROVISIONING_PROFILE: "",
  PROVISIONING_PROFILE_SPECIFIER: "",
  CODE_SIGN_IDENTITY: "Apple Development",
});
const MIN_BUNDLE_ID_SETTINGS = settings({
  HOT_UPDATER_MIN_BUNDLE_ID: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
});

describe("xcodebuild arguments", () => {
  it("archives with the MIN_BUNDLE_ID as a build setting and in the environment, and with the signing arguments", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      archiveDirectory: "/out/archive",
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
    // The archive is written where it is kept, and only the xcconfig's
    // directory is temporary.
    expect(args[args.indexOf("-archivePath") + 1]).toBe(
      "/out/archive/App.xcarchive",
    );
    expect(removeTmpDir).toHaveBeenCalledWith("/tmp/build");
    // The key signs a target set to manual signing automatically too.
    expect(args[args.indexOf("-xcconfig") + 1]).toBe(BUILD_XCCONFIG);
    expect(writeFile).toHaveBeenCalledWith(
      BUILD_XCCONFIG,
      `${MIN_BUNDLE_ID_SETTINGS}${AUTOMATIC_SIGNING}`,
    );
  });

  it("sets the MIN_BUNDLE_ID and automatic signing over the scheme's xcconfig and the ones in extraParams, which outrank the command line", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      archiveDirectory: "/out/archive",
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
      `#include "/app/ios/Release.xcconfig"\n#include "/configs/Manual.xcconfig"\n${MIN_BUNDLE_ID_SETTINGS}${AUTOMATIC_SIGNING}`,
    );
  });

  it("sets only the MIN_BUNDLE_ID over the scheme's xcconfig when it signs without an App Store Connect API key", async () => {
    await archiveXcodeProject({
      sourceDir: "/app/ios",
      archiveDirectory: "/out/archive",
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
      `#include "/app/ios/Release.xcconfig"\n${MIN_BUNDLE_ID_SETTINGS}`,
    );
  });

  it("exports with the signing arguments", async () => {
    await exportXcodeArchive({
      archivePath: "/tmp/App.xcarchive",
      exportPath: "/out/export",
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
      "/out/export",
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
      outputDirectory: "/out/app",
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
      `${MIN_BUNDLE_ID_SETTINGS}`,
    );
  });

  it("copies the built .app out of DerivedData, then removes DerivedData", async () => {
    const { appPath } = await buildXcodeProject({
      sourceDir: "/app/ios",
      outputDirectory: "/out/app",
      platform: "ios",
      xcodeScheme: "App",
      configuration: "Release",
      deviceType: "simulator",
      logPrefix: "ios-release-build",
      useGenericDestination: true,
      minBundleId: MIN_BUNDLE_ID,
    });

    const { args } = xcodebuildCall();
    expect(args[args.indexOf("-derivedDataPath") + 1]).toBe(
      "/tmp/build/DerivedData",
    );
    expect(appPath).toBe("/out/app/App.app");
    expect(cp).toHaveBeenCalledWith("/derived/Build/App.app", appPath, {
      recursive: true,
    });
    expect(removeTmpDir).toHaveBeenCalledWith("/tmp/build");
    expect(vi.mocked(removeTmpDir).mock.invocationCallOrder[0]).toBeGreaterThan(
      cp.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    [
      "build",
      () =>
        buildXcodeProject({
          sourceDir: "/app/ios",
          outputDirectory: "/out/app",
          platform: "ios",
          xcodeScheme: "App",
          configuration: "Release",
          deviceType: "simulator",
          logPrefix: "ios-release-build",
          minBundleId: MIN_BUNDLE_ID,
        }),
    ],
    [
      "archive",
      () =>
        archiveXcodeProject({
          sourceDir: "/app/ios",
          archiveDirectory: "/out/archive",
          platform: "ios",
          installPods: false,
          xcodeScheme: "App",
          logPrefix: "ios-release-build-archive",
          minBundleId: MIN_BUNDLE_ID,
        }),
    ],
  ])("removes the %s's temporary directory when it fails", async (_, run) => {
    vi.mocked(runXcodebuildWithLogging).mockRejectedValueOnce(
      new Error("xcodebuild exited with code 65."),
    );

    await expect(run()).rejects.toThrow("xcodebuild exited with code 65.");
    expect(removeTmpDir).toHaveBeenCalledWith("/tmp/build");
    expect(cp).not.toHaveBeenCalled();
  });

  it("builds a device app that signs with a key with automatic signing over the xcconfigs in extraParams", async () => {
    await buildXcodeProject({
      sourceDir: "/app/ios",
      outputDirectory: "/out/app",
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
      `#include "/app/ios/Manual.xcconfig"\n${MIN_BUNDLE_ID_SETTINGS}${AUTOMATIC_SIGNING}`,
    );
  });
});

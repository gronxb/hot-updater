import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// `pod install` writes the workspace, as it does on a freshly prebuilt `ios/`.
vi.mock("../utils/cocoapods", () => ({
  installPodsIfNeeded: vi.fn(async (sourceDir: string) => {
    await fs.mkdir(path.join(sourceDir, "App.xcworkspace"));
    return { codegen: false, pods: true };
  }),
}));
vi.mock("../utils/runXcodebuildWithLogging", () => ({
  runXcodebuildWithLogging: vi.fn(),
}));

import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";
import { archiveXcodeProject } from "./archiveXcodeProject";
import { buildXcodeProject } from "./buildXcodeProject";

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5";

let sourceDir: string;

beforeEach(async () => {
  // The built .app copied out of DerivedData.
  vi.spyOn(fs, "cp").mockResolvedValue(undefined);
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-ios-"));
  await fs.mkdir(path.join(sourceDir, "App.xcodeproj"));
  vi.mocked(runXcodebuildWithLogging)
    .mockClear()
    .mockResolvedValue({ logFilePath: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sourceDir, { recursive: true, force: true });
});

const xcodebuildProjectArgs = () => {
  const { args } = vi.mocked(runXcodebuildWithLogging).mock.calls[0]![0];
  const index = args.findIndex(
    (arg) => arg === "-workspace" || arg === "-project",
  );
  return args.slice(index, index + 2);
};

describe("a project whose workspace pod install creates", () => {
  it("builds the workspace", async () => {
    await buildXcodeProject({
      sourceDir,
      outputDirectory: path.join(sourceDir, "out"),
      platform: "ios",
      xcodeScheme: "App",
      configuration: "Debug",
      deviceType: "simulator",
      logPrefix: "ios-debug-build",
      useGenericDestination: true,
      installPods: true,
      minBundleId: MIN_BUNDLE_ID,
    });

    expect(xcodebuildProjectArgs()).toEqual([
      "-workspace",
      path.join(sourceDir, "App.xcworkspace"),
    ]);
  });

  it("archives the workspace", async () => {
    await archiveXcodeProject({
      sourceDir,
      archiveDirectory: path.join(sourceDir, "out"),
      platform: "ios",
      installPods: true,
      xcodeScheme: "App",
      logPrefix: "ios-release-build-archive",
      minBundleId: MIN_BUNDLE_ID,
    });

    expect(xcodebuildProjectArgs()).toEqual([
      "-workspace",
      path.join(sourceDir, "App.xcworkspace"),
    ]);
  });
});

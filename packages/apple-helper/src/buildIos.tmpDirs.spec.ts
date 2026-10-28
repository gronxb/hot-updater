import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CredentialResolver } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";

// plutil is macOS-only.
vi.mock("./utils/readBuiltApp", () => ({
  readBuiltApp: vi.fn(async () => ({
    appVersion: "1.0.0",
    channel: null,
    buildNumber: "1",
  })),
}));
// Never creates a keychain, in CI either.
vi.mock("./utils/ciSigningKeychain", () => ({
  withSigningKeychain: vi.fn(async ({ run }: { run: () => Promise<unknown> }) =>
    run(),
  ),
}));

// Leaves on disk what xcodebuild would: DerivedData with its indexes and
// the built .app, the .xcarchive, and the export's .ipa. With
// FAKE_XCODEBUILD_FAIL set to an action, that action fails, after writing
// what it had.
const FAKE_XCODEBUILD = `#!/bin/sh
action=""
while [ $# -gt 0 ]; do
  case "$1" in
    -derivedDataPath) derived="$2"; shift ;;
    -archivePath) archive="$2"; shift ;;
    -exportPath) exported="$2"; shift ;;
    -showBuildSettings) action=settings ;;
    -exportArchive) action=export ;;
    archive) action=archive ;;
    build) action=build ;;
  esac
  shift
done
products="$derived/Build/Products/Release-iphonesimulator"
case "$action" in
  settings)
    printf '[{"target":"App","action":"build","buildSettings":{"TARGET_BUILD_DIR":"%s","INFOPLIST_PATH":"App.app/Info.plist","EXECUTABLE_FOLDER_PATH":"App.app","FULL_PRODUCT_NAME":"App.app","WRAPPER_EXTENSION":"app"}}]\\n' "$products"
    exit 0 ;;
  build)
    mkdir -p "$derived/Index.noindex" "$derived/Logs" "$products/App.app"
    echo index > "$derived/Index.noindex/index"
    echo app > "$products/App.app/main.jsbundle" ;;
  archive)
    mkdir -p "$archive/Products/Applications/App.app"
    echo app > "$archive/Products/Applications/App.app/main.jsbundle" ;;
  export)
    mkdir -p "$exported"
    echo ipa > "$exported/App.ipa" ;;
esac
echo "note: Building targets in dependency order"
if [ "$FAKE_XCODEBUILD_FAIL" = "$action" ]; then
  echo "/src/App/AppDelegate.swift:12:5: error: cannot find 'missingSymbol' in scope"
  echo "** BUILD FAILED **"
  exit 65
fi
echo "** BUILD SUCCEEDED **"
`;

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5";
const originalPath = process.env["PATH"];

let projectDir: string;
let tmpDir: string;

const scheme = (
  overrides: Partial<EnrichedNativeBuildIosScheme> = {},
): EnrichedNativeBuildIosScheme => ({
  bundleIdentifier: "com.example",
  scheme: "App",
  platform: "ios",
  installPods: false,
  configuration: "Release",
  destination: [],
  simulator: false,
  hotUpdaterSchemeName: "release",
  ...overrides,
});

const buildIos = async (
  ...args: Parameters<typeof import("./buildIos").buildIos>
) => (await import("./buildIos")).buildIos(...args);

/** What is left in the system's temporary directory. */
const leftInTmp = () => fs.readdir(tmpDir);

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  // The project, and its .hot-updater/log, are outside the temporary
  // directory the build uses.
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-app-"));
  await fs.writeFile(path.join(projectDir, "package.json"), "{}");
  await fs.mkdir(path.join(projectDir, "ios", "App.xcodeproj"), {
    recursive: true,
  });
  const binDir = path.join(projectDir, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "xcodebuild"), FAKE_XCODEBUILD, {
    mode: 0o755,
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-tmp-"));

  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  // No real xcodebuild or xcbeautify.
  process.env["PATH"] = `${binDir}:/usr/bin:/bin`;
  vi.stubEnv("TMPDIR", tmpDir);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  // isXcbeautifyAvailable caches what it found.
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.env["PATH"] = originalPath;
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildIos's temporary directories", () => {
  it.each([
    ["a simulator .app", scheme({ simulator: true }), "app/App.app"],
    ["an .xcarchive", scheme(), "archive/App.xcarchive"],
    [
      "an exported .ipa",
      scheme({ exportOptionsPlist: "ExportOptions.plist" }),
      "export/App.ipa",
    ],
  ])(
    "leave only the build directory holding %s, which dispose removes",
    async (_, schemeConfig, artifact) => {
      const build = await buildIos({
        schemeConfig,
        minBundleId: MIN_BUNDLE_ID,
      });

      // DerivedData, the xcconfig and the export are gone; the artifact is
      // in the build directory, for the caller to copy out.
      expect(await leftInTmp()).toEqual([path.basename(build.buildDirectory)]);
      expect(path.dirname(build.buildDirectory)).toBe(tmpDir);
      expect(build.buildArtifactPath).toBe(
        path.join(build.buildDirectory, artifact),
      );
      expect(await exists(build.buildArtifactPath)).toBe(true);

      await build.dispose();
      expect(await leftInTmp()).toEqual([]);
    },
  );

  it("remove the directory that holds App Store Connect's export options", async () => {
    const resolve = vi.fn(async () => ({
      keyPath: "/keys/AuthKey_ABC.p8",
      keyId: "ABC",
      issuerId: "issuer",
    }));

    const build = await buildIos({
      schemeConfig: scheme({ signing: { ascApiKey: "secret:asc-api-key" } }),
      minBundleId: MIN_BUNDLE_ID,
      credentials: {
        resolve: resolve as typeof resolve & CredentialResolver["resolve"],
      },
    });

    expect(build.buildArtifactPath).toBe(
      path.join(build.buildDirectory, "export", "App.ipa"),
    );
    expect(await leftInTmp()).toEqual([path.basename(build.buildDirectory)]);
    await build.dispose();
    expect(await leftInTmp()).toEqual([]);
  });

  it.each([
    ["a simulator build", scheme({ simulator: true }), "build"],
    ["an archive", scheme(), "archive"],
    [
      "an export",
      scheme({ exportOptionsPlist: "ExportOptions.plist" }),
      "export",
    ],
  ])(
    "are all removed when %s fails, and its log is kept",
    async (_, schemeConfig, failingAction) => {
      vi.stubEnv("FAKE_XCODEBUILD_FAIL", failingAction);

      const error = await buildIos({
        schemeConfig,
        minBundleId: MIN_BUNDLE_ID,
      }).then(
        () => {
          throw new Error("Expected the build to fail.");
        },
        (reason: unknown) => reason as Error & { logPath: string | null },
      );

      expect(error.name).toBe("BuildFailedError");
      expect(await leftInTmp()).toEqual([]);
      expect(error.logPath).toMatch(/^\.hot-updater\/log\//);
      const log = await fs.readFile(
        path.join(projectDir, error.logPath!),
        "utf-8",
      );
      expect(log).toContain("error: cannot find 'missingSymbol' in scope");
    },
  );
});

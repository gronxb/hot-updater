import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  androidMatrixLaunchArguments,
  DIAGNOSTIC_MARKER,
  EVENT_MARKER,
  iosMatrixLaunchArguments,
  isRetryableAgentDeviceFailure,
  parseDiagnostics,
  parseEvents,
} from "../../examples/lynx/scripts/public-matrix/device-adapters.mjs";
import {
  assertTrackedSourceClean,
  deterministicArtifactSha256,
  iosArtifactAppId,
  parseAndroidApplicationId,
} from "../../examples/lynx/scripts/public-matrix/native-artifact-evidence.mjs";
import {
  appendSdkInstallFailureEvidence,
  readSdkInstallFailureEvidence,
} from "../../examples/lynx/scripts/public-matrix/raw-detail-rejection.mjs";
import { SPARKLING_NAVIGATION_PROVENANCE } from "../../packages/lynx/src/navigationProvenance";
import {
  LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS,
  LYNX_MATRIX_IOS_SPARKLING_CHECKOUT,
  LYNX_MATRIX_NATIVE_VERSIONS,
  LYNX_MATRIX_RUNTIME_IDS,
} from "./public-matrix-contract";

const native = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  getLaunchConfiguration: vi.fn().mockResolvedValue({
    appBaseURL: "https://updates.test",
  }),
  getLaunchInfo: vi.fn(),
  init: vi.fn(),
  notifyAppReady: vi.fn(),
  reload: vi.fn(),
}));
const TestLynxUpdaterError = vi.hoisted(
  () =>
    class LynxUpdaterError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message);
        this.name = "LynxUpdaterError";
      }
    },
);

vi.mock("../../packages/lynx/dist/index.mjs", () => ({
  HotUpdater: native,
  LynxUpdaterError: TestLynxUpdaterError,
}));

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runner = path.join(repo, "e2e/lynx/scripts/run-public-matrix.ts");
const nativeBuilder = path.join(
  repo,
  "examples/lynx/scripts/build-e2e-native.mjs",
);
const hash = (value: string) => value.repeat(64).slice(0, 64);
const nativeConfigSha256 = (files: Record<string, string>) =>
  createHash("sha256")
    .update(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, digest]) => `${file}\0${digest}\n`)
        .join(""),
    )
    .digest("hex");

function nativeReceipt(sourceCommit: string) {
  const nativePublicKeyFiles = {
    android: {
      "examples/lynx/android/app/src/main/AndroidManifest.xml": hash("6"),
      "examples/lynx/android/e2e-app/src/main/AndroidManifest.xml": hash("7"),
      "examples/lynx/android/matrix-app/src/main/AndroidManifest.xml":
        hash("8"),
    },
    ios: {
      "examples/lynx/ios/Info.plist": hash("9"),
      "examples/lynx/ios/MatrixHarness/NonProductionInfo.plist": hash("a"),
    },
  };
  const publicKeyIdentity = {
    schemaVersion: 1,
    provenance: "post-fingerprint-trust-anchor-injection",
    runtimeFingerprintRecalculated: false,
    algorithm: "rsa-spki",
    modulusLength: 2048,
    spkiSha256: hash("b"),
  };
  const nativeConfig = (platform: "ios" | "android") => {
    const basePaths =
      platform === "ios"
        ? [
            "examples/lynx/fingerprint.json",
            "examples/lynx/ios/Podfile",
            "examples/lynx/ios/Podfile.lock",
            "examples/lynx/ios/SparklingGo.xcodeproj/project.pbxproj",
            "examples/lynx/ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/SparklingMatrixHarness.xcscheme",
          ]
        : [
            "examples/lynx/fingerprint.json",
            "examples/lynx/android/settings.gradle.kts",
            "examples/lynx/android/gradle.properties",
            "examples/lynx/android/matrix-app/build.gradle.kts",
            "packages/lynx/android/build.gradle",
            "packages/lynx/android-sparkling/build.gradle",
          ];
    const files = {
      ...Object.fromEntries(
        basePaths.map((file, index) => [file, hash(String(index + 1))]),
      ),
      ...nativePublicKeyFiles[platform],
    };
    return {
      sha256: nativeConfigSha256(files),
      files,
      nativePublicKeyInjection: {
        ...publicKeyIdentity,
        files: nativePublicKeyFiles[platform],
      },
    };
  };
  return {
    schemaVersion: "lynx-native-artifacts-v2",
    target: "matrix",
    appId: "com.hotupdater.lynxmatrix",
    sourceCommit,
    sourceIntegrity: {
      checkedCommit: sourceCommit,
      clean: true,
      trackedChanges: [],
      trackedTreeSha256: hash("e"),
      allowedTrackedChanges: [
        "examples-server/hono-kysely-pglite/hot-updater_migrations/migration_2026-09-11T14-30-47.sql",
        "examples-server/hono-kysely-pglite/src/db.ts",
        "examples-server/hono-kysely-pglite/src/localFsStorage.mjs",
        "examples-server/hono-kysely-pglite/src/localFsStorage.ts",
        "examples/lynx/.gitignore",
        "examples/lynx/scripts/e2e-kysely-deploy.mjs",
      ],
      nativePublicKeyInjection: {
        ...publicKeyIdentity,
        files: {
          ...nativePublicKeyFiles.android,
          ...nativePublicKeyFiles.ios,
        },
      },
    },
    versions: { ...LYNX_MATRIX_NATIVE_VERSIONS },
    sparklingNavigation: { ...SPARKLING_NAVIGATION_PROVENANCE },
    artifacts: {
      ios: {
        path: "/tmp/SparklingMatrixHarness.app",
        appId: "com.hotupdater.lynxmatrix",
        sourceCommit,
        runtimeId: LYNX_MATRIX_RUNTIME_IDS.ios,
        binarySha256: hash("b"),
        artifactHashKind: "deterministic-full-app-tree-v1",
        nativeFingerprintSha256: hash("d"),
        nativeConfig: nativeConfig("ios"),
        scheme: "SparklingMatrixHarness",
        arch: "arm64",
        sparklingCheckout: { ...LYNX_MATRIX_IOS_SPARKLING_CHECKOUT },
      },
      android: {
        path: "/tmp/matrix-app-release.apk",
        appId: "com.hotupdater.lynxmatrix",
        sourceCommit,
        runtimeId: LYNX_MATRIX_RUNTIME_IDS.android,
        binarySha256: hash("a"),
        artifactHashKind: "full-apk-bytes",
        nativeFingerprintSha256: hash("d"),
        nativeConfig: nativeConfig("android"),
        task: ":matrix-app:assembleRelease",
        abis: ["arm64-v8a"],
        sparklingArtifacts: { ...LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS },
        sparklingDependencyGraphSha256:
          "c68329c1968de962c8574f298ba46f43db016195bbbf4422b5e01145278aebe3",
      },
    },
  };
}

function run(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", runner, ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

function buildNative(args: readonly string[]) {
  return spawnSync(process.execPath, [nativeBuilder, ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

function withInfoPlist<T>(
  contents: string | Buffer,
  assertion: (app: string) => T,
) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-plist-"));
  const app = path.join(temporary, "Fixture.app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "Info.plist"), contents);
  try {
    return assertion(app);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

describe("Lynx public matrix runner", () => {
  it("hashes the complete deterministic iOS app tree and derives artifact IDs", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-app-hash-"));
    const app = path.join(temporary, "Matrix.app");
    fs.mkdirSync(path.join(app, "Frameworks"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.hotupdater.lynxmatrix</string></dict></plist>`,
    );
    fs.writeFileSync(path.join(app, "Matrix"), "executable");
    fs.chmodSync(path.join(app, "Matrix"), 0o755);
    fs.writeFileSync(path.join(app, "Frameworks", "Sparkling"), "framework");
    fs.writeFileSync(path.join(app, "asset.txt"), "A");
    const before = deterministicArtifactSha256(app);
    expect(iosArtifactAppId(app)).toBe("com.hotupdater.lynxmatrix");
    fs.writeFileSync(path.join(app, "asset.txt"), "B");
    expect(deterministicArtifactSha256(app)).not.toBe(before);
    expect(
      parseAndroidApplicationId("package: name='com.hotupdater.lynxmatrix'"),
    ).toBe("com.hotupdater.lynxmatrix");
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it("reads the single top-level identifier from a valid XML plist", () => {
    withInfoPlist(
      "<plist><dict><key>CFBundleIdentifier</key><string>com.hotupdater.valid</string></dict></plist>",
      (app) => expect(iosArtifactAppId(app)).toBe("com.hotupdater.valid"),
    );
  });

  it("does not accept an identifier embedded in an XML comment", () => {
    withInfoPlist(
      "<plist><!-- <key>CFBundleIdentifier</key><string>com.hotupdater.bait</string> --><dict><key>Name</key><string>Fixture</string></dict></plist>",
      (app) =>
        expect(() => iosArtifactAppId(app)).toThrow(
          "one top-level CFBundleIdentifier",
        ),
    );
  });

  it("ignores a nested identifier before the top-level identifier", () => {
    withInfoPlist(
      "<plist><dict><key>Nested</key><dict><key>CFBundleIdentifier</key><string>com.hotupdater.bait</string></dict><key>CFBundleIdentifier</key><string>com.hotupdater.real</string></dict></plist>",
      (app) => expect(iosArtifactAppId(app)).toBe("com.hotupdater.real"),
    );
  });

  it("rejects duplicate top-level identifiers", () => {
    withInfoPlist(
      "<plist><dict><key>CFBundleIdentifier</key><string>com.hotupdater.first</string><key>CFBundleIdentifier</key><string>com.hotupdater.second</string></dict></plist>",
      (app) =>
        expect(() => iosArtifactAppId(app)).toThrow(
          "one top-level CFBundleIdentifier",
        ),
    );
  });

  it("rejects malformed XML without falling back to plutil", () => {
    const plutil = vi.fn();
    withInfoPlist(
      "<plist><dict><key>CFBundleIdentifier</key><string>com.hotupdater.invalid</dict></plist>",
      (app) =>
        expect(() => iosArtifactAppId(app, plutil)).toThrow(
          "Invalid XML Info.plist",
        ),
    );
    expect(plutil).not.toHaveBeenCalled();
  });

  it("rejects a dictionary with a trailing key", () => {
    withInfoPlist(
      "<plist><dict><key>CFBundleIdentifier</key><string>com.hotupdater.valid</string><key>Trailing</key></dict></plist>",
      (app) =>
        expect(() => iosArtifactAppId(app)).toThrow(
          "Info.plist dictionary is malformed",
        ),
    );
  });

  it("uses plutil for a binary plist", () => {
    const plutil = vi.fn().mockReturnValue({
      status: 0,
      stderr: "",
      stdout: "com.hotupdater.binary\n",
    });
    withInfoPlist(Buffer.from("bplist00fixture"), (app) => {
      expect(iosArtifactAppId(app, plutil)).toBe("com.hotupdater.binary");
      expect(plutil).toHaveBeenCalledWith(
        "plutil",
        ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Info.plist")],
        { encoding: "utf8" },
      );
    });
  });

  it("rejects a runnable native receipt build from dirty tracked source", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-source-"));
    spawnSync("git", ["init", "-q"], { cwd: temporary });
    spawnSync("git", ["config", "user.email", "e2e@example.invalid"], {
      cwd: temporary,
    });
    spawnSync("git", ["config", "user.name", "E2E"], { cwd: temporary });
    fs.writeFileSync(path.join(temporary, "native.txt"), "clean");
    spawnSync("git", ["add", "native.txt"], { cwd: temporary });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: temporary });
    expect(assertTrackedSourceClean(temporary)).toMatchObject({ clean: true });
    fs.writeFileSync(path.join(temporary, "native.txt"), "dirty");
    expect(() => assertTrackedSourceClean(temporary)).toThrow(
      "require clean tracked source",
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it.each(["react", "vue", "octane"])(
    "passes runtime endpoints to every %s matrix launch on both platforms",
    (framework) => {
      const baseURL = "http://updates.test/hot-updater";
      const encoded = JSON.stringify({ appBaseURL: baseURL });
      expect(iosMatrixLaunchArguments(framework, "qa", baseURL)).toContain(
        `--hot-updater-launch-configuration=${encoded}`,
      );
      expect(androidMatrixLaunchArguments(framework, "qa", baseURL)).toEqual([
        "--es",
        "framework",
        framework,
        "--es",
        "channel",
        "qa",
        "--es",
        "hotUpdaterLaunchConfiguration",
        encoded,
      ]);
    },
  );

  it("retries only the explicit agent-device runner-busy response", () => {
    expect(
      isRetryableAgentDeviceFailure({
        success: false,
        error: { code: "RUNNER_BUSY", retriable: true },
      }),
    ).toBe(true);
    expect(
      isRetryableAgentDeviceFailure({
        success: false,
        error: { code: "RUNNER_BUSY", retriable: false },
      }),
    ).toBe(false);
    expect(
      isRetryableAgentDeviceFailure({
        success: false,
        error: { code: "DEVICE_NOT_FOUND", retriable: true },
      }),
    ).toBe(false);
  });

  it("builds the dedicated matrix targets and emits their exact artifact paths", () => {
    const result = buildNative(["--", "--dry-run", "--target", "matrix"]);
    expect(result.status).toBe(0);
    const encoded = result.stdout
      .split("\n")
      .find((line) => line.startsWith("LYNX_NATIVE_ARTIFACTS="));
    expect(encoded).toBeTruthy();
    const receipt = JSON.parse(encoded!.split("=").slice(1).join("="));
    expect(receipt).toMatchObject({
      schemaVersion: "lynx-native-artifacts-v2",
      target: "matrix",
      appId: "com.hotupdater.lynxmatrix",
      artifacts: {
        ios: {
          scheme: "SparklingMatrixHarness",
          arch: process.arch === "arm64" ? "arm64" : "x86_64",
        },
        android: { task: ":matrix-app:assembleRelease" },
      },
    });
    expect(receipt.artifacts.ios.path).toMatch(/SparklingMatrixHarness\.app$/);
    expect(receipt.artifacts.android.path).toMatch(/matrix-app-release\.apk$/);
    expect(result.stdout).not.toContain('"scheme":"SparklingGo"');
    expect(result.stdout).not.toContain('"task":":app:assembleRelease"');
  });

  it("keeps the production scaffold as a separately selected validation build", () => {
    const result = buildNative(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"target":"scaffold"');
    expect(result.stdout).toContain('"scheme":"SparklingGo"');
    expect(result.stdout).toContain('"task":":app:assembleRelease"');
    expect(result.stdout).toContain(
      "/ios/build/Build/Products/Release-iphonesimulator/SparklingGo.app",
    );
  });

  it("builds shipped E2E in its dedicated nonproduction targets", () => {
    const result = buildNative(["--dry-run", "--target", "e2e"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"target":"e2e"');
    expect(result.stdout).toContain('"scheme":"SparklingGoE2E"');
    expect(result.stdout).toContain('"task":":e2e-app:assembleRelease"');
    expect(result.stdout).toContain(
      "/ios/build/e2e/Build/Products/Release-iphonesimulator/SparklingGoE2E.app",
    );
  });

  it("validates the matrix artifact receipt before a dry run", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "lynx-native-artifacts-"),
    );
    const receiptPath = path.join(temporary, "artifacts.json");
    const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const receipt = nativeReceipt(sourceCommit);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(run(["--dry-run", "--native-artifacts", receiptPath]).status).toBe(
      0,
    );
    receipt.appId = "com.hotupdater.lynxexample";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(run(["--dry-run", "--native-artifacts", receiptPath]).status).toBe(
      1,
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it("keeps a failed public SDK install as a failure and never reloads", async () => {
    vi.resetModules();
    vi.stubGlobal("__SPIKE_VARIANT__", "B");
    vi.stubGlobal("__SPIKE_BEHAVIOR__", "normal");
    vi.stubGlobal("__SPIKE_ASSET_PREFIX__", "hu://");
    vi.stubGlobal("__SDK_RESOURCES__", false);
    native.getLaunchInfo.mockResolvedValue({
      running: { bundleId: "bundle-b", releaseId: "release-b" },
    });
    native.notifyAppReady.mockResolvedValue({ status: "UNCHANGED" });
    const updateBundle = vi.fn().mockResolvedValue(false);
    native.checkForUpdate.mockResolvedValue({
      id: "release-c",
      bundleId: "bundle-c",
      releaseId: "release-c",
      transitionKind: "UPDATE",
      updateBundle,
    });
    const sdk = await import("../../examples/lynx/spike/sdk");
    const setStatus = vi.fn();
    const setCanInstall = vi.fn();
    sdk.sdkImageLoaded();
    await sdk.startSdk(setStatus, vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await sdk.checkSdkUpdate(setStatus, setCanInstall);

    await expect(
      sdk.installSdkUpdateAndReload(setStatus, setCanInstall),
    ).rejects.toThrow("The verified SDK update was not installed");
    expect(updateBundle).toHaveBeenCalledOnce();
    expect(native.reload).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.stringContaining("Install and reload failed"),
    );
  });

  it("publishes the exact native updater code and message for install evidence", async () => {
    vi.resetModules();
    vi.stubGlobal("__SPIKE_VARIANT__", "B");
    vi.stubGlobal("__SPIKE_BEHAVIOR__", "normal");
    vi.stubGlobal("__SPIKE_ASSET_PREFIX__", "hu://");
    vi.stubGlobal("__SDK_RESOURCES__", false);
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "lynx-install-failure-"),
    );
    const evidenceFile = path.join(temporary, "failures.jsonl");
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url !== "/matrix-install-failure") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await appendSdkInstallFailureEvidence(evidenceFile, body.failure);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ stored: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server");
    native.getLaunchConfiguration.mockResolvedValue({
      appBaseURL: `http://127.0.0.1:${address.port}/hot-updater`,
    });
    native.getLaunchInfo.mockResolvedValue({
      running: { bundleId: "bundle-b", releaseId: "release-b" },
    });
    native.notifyAppReady.mockResolvedValue({ status: "UNCHANGED" });
    native.checkForUpdate.mockResolvedValue({
      id: "release-c",
      bundleId: "bundle-c",
      releaseId: "release-c",
      transitionKind: "INSTALL",
      updateBundle: vi
        .fn()
        .mockRejectedValue(
          new TestLynxUpdaterError(
            "FILE_HASH_MISMATCH",
            "File hash verification failed",
          ),
        ),
    });
    const sdk = await import("../../examples/lynx/spike/sdk");
    const setStatus = vi.fn();
    sdk.sdkImageLoaded();
    await sdk.startSdk(setStatus, vi.fn(), vi.fn(), vi.fn(), vi.fn());
    await sdk.checkSdkUpdate(setStatus, vi.fn());
    await sdk.installSdkUpdate(setStatus, vi.fn());

    expect(setStatus).toHaveBeenLastCalledWith(
      "Installation failed: [FILE_HASH_MISMATCH] File hash verification failed",
    );
    expect(readSdkInstallFailureEvidence(evidenceFile)).toMatchObject([
      {
        transport: "matrix-control-http",
        failure: {
          bundleId: "bundle-c",
          code: "FILE_HASH_MISMATCH",
          message: "File hash verification failed",
          releaseId: "release-c",
        },
      },
    ]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it("parses the iOS bare JSONL sink and Android marked log lines", () => {
    const event = {
      event: "generationStarted",
      processId: "101",
      generationId: "generation-a",
    };
    expect(parseEvents(`${JSON.stringify(event)}\n`)).toEqual([event]);
    expect(
      parseEvents(
        `09-13 I/HotUpdaterLynx: ${EVENT_MARKER}${JSON.stringify(event)}`,
      ),
    ).toEqual([event]);
    const diagnostic = {
      action: "navigationStackBoundary",
      ok: true,
      processId: "101",
      data: { rejectionCode: "STACK_LIMIT_EXCEEDED" },
    };
    expect(
      parseDiagnostics(
        `09-13 I/HotUpdaterLynx: ${DIAGNOSTIC_MARKER}${JSON.stringify(diagnostic)}`,
      ),
    ).toEqual([diagnostic]);
    expect(parseDiagnostics(`${JSON.stringify(diagnostic)}\n`)).toEqual([
      diagnostic,
    ]);
    expect(() =>
      parseDiagnostics(`${DIAGNOSTIC_MARKER}{"action":"broken"}`),
    ).toThrow("Invalid matrix diagnostic");
  });

  it("plans all six framework and OS cells with every required phase", () => {
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    for (const cell of [
      "react-ios",
      "vue-ios",
      "octane-ios",
      "react-android",
      "vue-android",
      "octane-android",
    ]) {
      expect(result.stdout).toContain(`- ${cell}`);
    }
    for (const phase of [
      "embedded A with exact resources and readiness",
      "real A to B BSDIFF plus raw detail staged for offline activation",
      "origin-off B activation",
      "origin-off B retained launch",
      "real B to C BSDIFF and same-process generation reload",
      "retained old-context rejection after reload",
      "primary removal and full generation recreation",
      "fatal detail after primary confirmation and full generation recovery",
      "fatal detail before primary confirmation and full generation recovery",
      "pending detail process death after confirmation and full-stack recovery",
      "pending detail process death before confirmation and full-stack recovery",
      "reverse C to B and B to server A BSDIFF rollback",
    ]) {
      expect(result.stdout).toContain(phase);
    }
  });

  it("can select one cell without requiring device arguments in dry-run", () => {
    const result = run([
      "--dry-run",
      "--platform",
      "android",
      "--framework",
      "vue",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("- vue-android");
    expect(result.stdout).not.toContain("- react-android");
    expect(result.stdout).not.toContain("- vue-ios");
  });

  it("accepts pnpm's literal argument separator", () => {
    const result = run([
      "--",
      "--dry-run",
      "--platform",
      "ios",
      "--framework",
      "react",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("- react-ios");
  });

  it("rejects an unknown framework before doing any device work", () => {
    const result = run(["--dry-run", "--framework", "solid"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Choose framework react, vue, octane, or all",
    );
  });

  it("fails a normal run before reporting success when required evidence targets are missing", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--native-artifacts is required");
    expect(result.stdout).not.toContain("[lynx-matrix:passed]");
  });
});

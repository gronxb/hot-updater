import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  EVENT_MARKER,
  parseEvents,
} from "../../examples/lynx/scripts/public-matrix/device-adapters.mjs";

const native = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  getLaunchInfo: vi.fn(),
  init: vi.fn(),
  notifyAppReady: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("../../packages/lynx/dist/index.mjs", () => ({ HotUpdater: native }));

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runner = path.join(repo, "e2e/lynx/scripts/run-public-matrix.ts");
const nativeBuilder = path.join(
  repo,
  "examples/lynx/scripts/build-e2e-native.mjs",
);

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

describe("Lynx public matrix runner", () => {
  it("builds the dedicated matrix targets and emits their exact artifact paths", () => {
    const result = buildNative(["--", "--dry-run"]);
    expect(result.status).toBe(0);
    const encoded = result.stdout
      .split("\n")
      .find((line) => line.startsWith("LYNX_NATIVE_ARTIFACTS="));
    expect(encoded).toBeTruthy();
    const receipt = JSON.parse(encoded!.split("=").slice(1).join("="));
    expect(receipt).toMatchObject({
      schemaVersion: "lynx-native-artifacts-v1",
      target: "matrix",
      appId: "com.hotupdater.lynxmatrix",
      artifacts: {
        ios: { scheme: "SparklingMatrixHarness" },
        android: { task: ":matrix-app:assembleRelease" },
      },
    });
    expect(receipt.artifacts.ios.path).toMatch(/SparklingMatrixHarness\.app$/);
    expect(receipt.artifacts.android.path).toMatch(/matrix-app-release\.apk$/);
    expect(result.stdout).not.toContain('"scheme":"SparklingGo"');
    expect(result.stdout).not.toContain('"task":":app:assembleRelease"');
  });

  it("keeps the production scaffold as a separately selected validation build", () => {
    const result = buildNative(["--dry-run", "--target", "scaffold"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"target":"scaffold"');
    expect(result.stdout).toContain('"scheme":"SparklingGo"');
    expect(result.stdout).toContain('"task":":app:assembleRelease"');
  });

  it("validates the matrix artifact receipt before a dry run", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "lynx-native-artifacts-"),
    );
    const receiptPath = path.join(temporary, "artifacts.json");
    const receipt = {
      schemaVersion: "lynx-native-artifacts-v1",
      target: "matrix",
      appId: "com.hotupdater.lynxmatrix",
      artifacts: {
        ios: { path: "/tmp/SparklingMatrixHarness.app" },
        android: { path: "/tmp/matrix-app-release.apk" },
      },
    };
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
    vi.stubGlobal("__SDK_BASE_URL__", "https://updates.test");
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
      "full archive A to B",
      "origin-off B activation",
      "origin-off B retained launch",
      "real B to C BSDIFF and same-process generation reload",
      "retained old-context rejection after reload",
      "primary removal and full generation recreation",
      "secondary fatal candidate and full generation recovery",
      "unconfirmed candidate recovery",
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
    expect(result.stderr).toContain("--results-dir is required");
    expect(result.stdout).not.toContain("[lynx-matrix:passed]");
  });
});

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createNativeBuildPlan, parseNativeBuildArgs } from "./build.ts";

const deviceId = "12345678-1234-1234-1234-1234567890AB";
const otherDeviceId = "ABCDEFAB-1234-1234-1234-1234567890AB";

describe("native Release builds", () => {
  it("builds the debuggable Android Release app without an instrumentation APK", () => {
    const [command] = createNativeBuildPlan(
      { platform: "android", dryRun: false },
      "/checkout with spaces",
      { HOT_UPDATER_E2E_ANDROID_ARCHITECTURES: "arm64-v8a" },
    );
    expect(command).toEqual({
      command: "./gradlew",
      args: [
        "--no-daemon",
        ":app:assembleRelease",
        "-Pkotlin.compiler.execution.strategy=in-process",
        "-PreactNativeArchitectures=arm64-v8a",
        "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
        "-PMIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000",
      ],
      cwd: "/checkout with spaces/examples/v0.85.0/android",
      env: {},
    });
  });

  it("preserves both Android simulator architectures by default", () => {
    const [command] = createNativeBuildPlan(
      { platform: "android", dryRun: false },
      "/checkout",
      {},
    );
    expect(command.args).toContain(
      "-PreactNativeArchitectures=arm64-v8a,x86_64",
    );
  });

  it("installs prebuilt RN pods before the explicit iOS Release simulator build", () => {
    const [pods, xcode] = createNativeBuildPlan(
      { platform: "ios", deviceId, dryRun: false },
      "/checkout",
      { HOT_UPDATER_E2E_DEVICE_ID: otherDeviceId },
    );
    expect(pods).toEqual({
      command: "bundle",
      args: ["exec", "pod", "install"],
      cwd: "/checkout/examples/v0.85.0/ios",
      env: { RCT_USE_PREBUILT_RNCORE: "1", RCT_USE_RN_DEP: "1" },
    });
    expect(xcode.args).toEqual([
      "-workspace",
      "HotUpdaterExample.xcworkspace",
      "-scheme",
      "HotUpdaterExample",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${deviceId}`,
      "-derivedDataPath",
      "build",
      "-quiet",
      "HOT_UPDATER_MIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000",
    ]);
    expect(xcode.cwd).toBe(pods.cwd);
  });

  it("accepts the bot's existing explicit iOS device and build path environment", () => {
    const [, xcode] = createNativeBuildPlan(
      { platform: "ios", dryRun: false },
      "/checkout",
      {
        HOT_UPDATER_E2E_DEVICE_ID: deviceId,
        HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: "/build cache/ios",
      },
    );
    expect(xcode.args).toContain(`id=${deviceId}`);
    expect(xcode.args).toContain("/build cache/ios");
  });

  it("builds for generic simulators before a device lease and rejects names as IDs", () => {
    const [, xcode] = createNativeBuildPlan(
      { platform: "ios", dryRun: false },
      "/checkout",
      {},
    );
    expect(xcode.args).toContain("generic/platform=iOS Simulator");
    expect(() =>
      createNativeBuildPlan(
        { platform: "ios", deviceId: "iPhone 16", dryRun: false },
        "/checkout",
        {},
      ),
    ).toThrow("simulator UDID");
  });

  it("rejects unknown platforms and missing values before running native tools", () => {
    expect(() => parseNativeBuildArgs(["--platform", "all"])).toThrow(
      "Unsupported platform",
    );
    expect(() => parseNativeBuildArgs(["--platform", "--dry-run"])).toThrow(
      "Missing value",
    );
    expect(() => parseNativeBuildArgs([])).toThrow("--platform");
  });

  it("prints an iOS dry-run plan with no device or native executables available", () => {
    const script = fileURLToPath(new URL("./build.ts", import.meta.url));
    const stdout = execFileSync(
      process.execPath,
      [script, "--", "--platform", "ios", "--dry-run"],
      {
        cwd: path.dirname(script),
        env: { PATH: "/nonexistent" },
        encoding: "utf8",
      },
    );
    const plan = JSON.parse(stdout);
    expect(plan.map((command: { command: string }) => command.command)).toEqual(
      ["bundle", "xcodebuild"],
    );
    expect(plan[1].args).toContain("generic/platform=iOS Simulator");
    expect(plan[1].cwd).toBe(
      fileURLToPath(new URL("../../examples/v0.85.0/ios", import.meta.url)),
    );
  });
});

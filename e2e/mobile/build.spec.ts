import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadE2eTarget } from "../shared/targets.ts";
import {
  COCOAPODS_NULL_BYTE_CRASH,
  createNativeBuildPlan,
  parseNativeBuildArgs,
  shouldRetryNativeBuildStep,
} from "./build.ts";

const deviceId = "12345678-1234-1234-1234-1234567890AB";
const minBundleId = "019a0b1c-2d3e-7000-8000-000000000000";
const otherDeviceId = "ABCDEFAB-1234-1234-1234-1234567890AB";
const app = loadE2eTarget("v0.85.0");
const brownfield = loadE2eTarget("brownfield-host");

describe("native Release builds", () => {
  it("packages the example as an AAR and builds the Android brownfield host", () => {
    expect(
      createNativeBuildPlan(
        { platform: "android", target: brownfield, dryRun: false },
        "/checkout",
        { HOT_UPDATER_E2E_ANDROID_ARCHITECTURES: "arm64-v8a" },
        minBundleId,
      ),
    ).toEqual([
      {
        command: "rm",
        args: ["-rf", "brownfieldlib/build"],
        cwd: "/checkout/examples/v0.85.0/android",
        env: {},
      },
      {
        command: "./gradlew",
        args: [
          "--no-daemon",
          ":brownfieldlib:publishMavenAarPublicationToBrownfieldE2eRepository",
          "-Pkotlin.compiler.execution.strategy=in-process",
          "-PreactNativeArchitectures=arm64-v8a",
          `-PMIN_BUNDLE_ID=${minBundleId}`,
        ],
        cwd: "/checkout/examples/v0.85.0/android",
        env: { NODE_ENV: "production", BABEL_ENV: "production" },
      },
      {
        command: "./gradlew",
        args: [
          "--no-daemon",
          ":app:assembleRelease",
          "-Pkotlin.compiler.execution.strategy=in-process",
          "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
        ],
        cwd: "/checkout/examples/brownfield-host/android",
        env: {},
      },
    ]);
  });

  it("packages the example as an XCFramework and builds the iOS brownfield host", () => {
    const [install, pods, framework, host] = createNativeBuildPlan(
      { platform: "ios", target: brownfield, deviceId, dryRun: false },
      "/checkout",
      { HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: "/derived" },
      minBundleId,
    );
    expect(install!.cwd).toBe("/checkout/examples/v0.85.0/ios");
    expect(pods!.args).toEqual(["exec", "pod", "install"]);
    expect(framework).toEqual({
      command: "/checkout/examples/v0.85.0/node_modules/.bin/brownfield",
      args: [
        "package:ios",
        "--scheme",
        "HotUpdaterExampleBrownfield",
        "--configuration",
        "Release",
        "--no-install-pods",
        "--build-folder",
        "/derived/framework",
        "--extra-params",
        `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
      ],
      cwd: "/checkout/examples/v0.85.0",
      env: { NODE_ENV: "production", BABEL_ENV: "production" },
    });
    expect(host).toEqual({
      command: "xcodebuild",
      args: [
        "-project",
        "HotUpdaterExampleHost.xcodeproj",
        "-scheme",
        "HotUpdaterExampleHost",
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        `id=${deviceId}`,
        "-derivedDataPath",
        "/derived",
        "-quiet",
      ],
      cwd: "/checkout/examples/brownfield-host/ios",
      env: {},
    });
  });

  it("selects the target, defaulting to v0.85.0, with --track brownfield as the brownfield one", () => {
    expect(parseNativeBuildArgs(["--platform", "ios"], {}).target.name).toBe(
      "v0.85.0",
    );
    expect(
      parseNativeBuildArgs(["--platform", "ios", "--track", "brownfield"], {})
        .target.name,
    ).toBe("brownfield-host");
    expect(
      parseNativeBuildArgs(["--platform", "ios", "--target", "v0.85.0"], {})
        .target.name,
    ).toBe("v0.85.0");
    expect(
      parseNativeBuildArgs(["--platform", "ios"], {
        HOT_UPDATER_E2E_ENV_TARGET_RELATIVE_DIR: "examples/brownfield-host",
      }).target.name,
    ).toBe("brownfield-host");
    expect(() =>
      parseNativeBuildArgs(["--platform", "ios", "--track", "expo"], {}),
    ).toThrow("Unknown E2E track: expo");
    expect(() =>
      parseNativeBuildArgs(["--platform", "ios", "--target", "expo-52"], {}),
    ).toThrow("Unknown E2E target expo-52");
  });

  it("builds the debuggable Android Release app without an instrumentation APK", () => {
    const [command] = createNativeBuildPlan(
      { platform: "android", target: app, dryRun: false },
      "/checkout with spaces",
      { HOT_UPDATER_E2E_ANDROID_ARCHITECTURES: "arm64-v8a" },
      minBundleId,
    );
    expect(command).toEqual({
      command: "./gradlew",
      args: [
        "--no-daemon",
        ":app:assembleRelease",
        "-Pkotlin.compiler.execution.strategy=in-process",
        "-PreactNativeArchitectures=arm64-v8a",
        "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
        `-PMIN_BUNDLE_ID=${minBundleId}`,
      ],
      cwd: "/checkout with spaces/examples/v0.85.0/android",
      env: { NODE_ENV: "production", BABEL_ENV: "production" },
    });
  });

  it("preserves both Android simulator architectures by default", () => {
    const [command] = createNativeBuildPlan(
      { platform: "android", target: app, dryRun: false },
      "/checkout",
      {},
    );
    expect(command.args).toContain(
      "-PreactNativeArchitectures=arm64-v8a,x86_64",
    );
  });

  it("installs prebuilt RN pods before the explicit iOS Release simulator build", () => {
    const [install, pods, xcode] = createNativeBuildPlan(
      { platform: "ios", target: app, deviceId, dryRun: false },
      "/checkout",
      { HOT_UPDATER_E2E_DEVICE_ID: otherDeviceId },
      minBundleId,
    );
    expect(install).toEqual({
      command: "bundle",
      args: ["install"],
      cwd: "/checkout/examples/v0.85.0/ios",
      env: {
        BUNDLE_GEMFILE: "/checkout/examples/v0.85.0/Gemfile",
        BUNDLE_PATH: "/checkout/examples/v0.85.0/vendor/bundle",
        BUNDLE_FROZEN: "1",
      },
    });
    expect(pods).toEqual({
      command: "bundle",
      args: ["exec", "pod", "install"],
      cwd: "/checkout/examples/v0.85.0/ios",
      env: {
        ...install.env,
        RCT_USE_PREBUILT_RNCORE: "1",
        RCT_USE_RN_DEP: "1",
      },
      retryOn: COCOAPODS_NULL_BYTE_CRASH,
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
      `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
    ]);
    expect(xcode.cwd).toBe(pods.cwd);
  });

  it("accepts the bot's existing explicit iOS device and build path environment", () => {
    const [, , xcode] = createNativeBuildPlan(
      { platform: "ios", target: app, dryRun: false },
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
    const [, , xcode] = createNativeBuildPlan(
      { platform: "ios", target: app, dryRun: false },
      "/checkout",
      {},
    );
    expect(xcode.args).toContain("generic/platform=iOS Simulator");
    expect(() =>
      createNativeBuildPlan(
        { platform: "ios", target: app, deviceId: "iPhone 16", dryRun: false },
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

  it("prints a dry-run plan through a symlink with no native executables available", async () => {
    const script = fileURLToPath(new URL("./build.ts", import.meta.url));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-build-link-"));
    const link = path.join(root, "build.ts");
    try {
      await fs.symlink(script, link);
      const stdout = execFileSync(
        process.execPath,
        [link, "--", "--platform", "ios", "--dry-run"],
        {
          cwd: root,
          env: { PATH: "/nonexistent" },
          encoding: "utf8",
        },
      );
      const plan = JSON.parse(stdout);
      expect(
        plan.map((command: { command: string }) => command.command),
      ).toEqual(["bundle", "bundle", "xcodebuild"]);
      expect(plan[2].args).toContain("generic/platform=iOS Simulator");
      expect(plan[2].cwd).toBe(
        fileURLToPath(new URL("../../examples/v0.85.0/ios", import.meta.url)),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops a cancelled build's compiler descendants and does not start the next step", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "native-build-cancel-"),
    );
    const source = fileURLToPath(new URL("./build.ts", import.meta.url));
    const script = path.join(root, "e2e/mobile/build.ts");
    const bin = path.join(root, "bin");
    const heartbeat = path.join(root, "heartbeat");
    const ready = path.join(root, "ready");
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.mkdir(path.join(root, "examples/v0.85.0/ios"), {
      recursive: true,
    });
    await fs.mkdir(bin);
    await fs.copyFile(source, script);
    await fs.mkdir(path.join(root, "e2e/shared"), { recursive: true });
    for (const shared of ["targets.ts", "built-in-bundle-id.ts"]) {
      await fs.copyFile(
        fileURLToPath(new URL(`../shared/${shared}`, import.meta.url)),
        path.join(root, "e2e/shared", shared),
      );
    }
    await fs.writeFile(path.join(root, "examples/v0.85.0/e2e.json"), "{}");
    const compiler = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const beat = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()));
      beat();
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(beat, 20);
    `;
    await fs.writeFile(
      path.join(bin, "bundle"),
      `#!${process.execPath}\nconst {spawn} = require('node:child_process');
      const fs = require('node:fs');
      if (process.argv[2] !== 'install') {
        fs.writeFileSync(${JSON.stringify(path.join(root, "next-step"))}, 'ran');
        process.exit(0);
      }
      process.on('SIGTERM', () => process.exit(0));
      spawn(process.execPath, ['-e', ${JSON.stringify(compiler)}], {stdio: 'inherit'});
      setInterval(() => {}, 1000);`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [script, "--platform", "ios"], {
      env: { PATH: bin },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let compilerPid: number | undefined;
    try {
      await expect
        .poll(async () => {
          try {
            return await fs.readFile(ready, "utf8");
          } catch {
            return "";
          }
        })
        .not.toBe("");
      compilerPid = Number(await fs.readFile(ready, "utf8"));
      child.kill("SIGTERM");
      expect(await exited).toBe(143);
      const stopped = await fs.readFile(heartbeat, "utf8");
      await sleep(100);
      expect(await fs.readFile(heartbeat, "utf8")).toBe(stopped);
      await expect(fs.stat(path.join(root, "next-step"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      child.kill("SIGKILL");
      if (compilerPid) {
        try {
          process.kill(compilerPid, "SIGKILL");
        } catch {}
      }
      await exited;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("retries only pod install, on CocoaPods' null byte crash, once", () => {
    for (const target of [app, loadE2eTarget("v0.74.1"), brownfield]) {
      for (const platform of ["ios", "android"] as const) {
        const plan = createNativeBuildPlan(
          { platform, target, dryRun: false },
          "/checkout",
          {},
        );
        expect(
          plan
            .filter((command) => command.retryOn !== undefined)
            .map((command) => [command.args.join(" "), command.retryOn]),
        ).toEqual(
          platform === "ios"
            ? [["exec pod install", COCOAPODS_NULL_BYTE_CRASH]]
            : [],
        );
      }
    }
    const [install, pods, xcode] = createNativeBuildPlan(
      { platform: "ios", target: app, dryRun: false },
      "/checkout",
      {},
    );
    const crash = `ArgumentError - ${COCOAPODS_NULL_BYTE_CRASH}\n/gems/cocoapods-1.14.3/lib/cocoapods/project.rb:452`;
    expect(shouldRetryNativeBuildStep(pods!, 1, crash, 1)).toBe(true);
    expect(shouldRetryNativeBuildStep(pods!, 1, crash, 2)).toBe(false);
    expect(shouldRetryNativeBuildStep(pods!, 0, crash, 1)).toBe(false);
    expect(
      shouldRetryNativeBuildStep(pods!, 1, "[!] Unable to find a specification", 1),
    ).toBe(false);
    expect(shouldRetryNativeBuildStep(install!, 1, crash, 1)).toBe(false);
    expect(shouldRetryNativeBuildStep(xcode!, 65, crash, 1)).toBe(false);
  });

  it.each([
    {
      name: "reruns pod install after the null byte crash, keeping the first attempt's log",
      firstFailure: `ArgumentError - ${COCOAPODS_NULL_BYTE_CRASH}`,
      exitCode: 0,
      podRuns: 2,
    },
    {
      name: "fails on any other pod install error without a rerun",
      firstFailure: "[!] Unable to find a specification for `Missing`",
      exitCode: 1,
      podRuns: 1,
    },
  ])("$name", async ({ firstFailure, exitCode, podRuns }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-build-retry-"));
    const source = fileURLToPath(new URL("./build.ts", import.meta.url));
    const script = path.join(root, "e2e/mobile/build.ts");
    const bin = path.join(root, "bin");
    const runs = path.join(root, "runs");
    try {
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.mkdir(path.join(root, "examples/v0.85.0/ios"), {
        recursive: true,
      });
      await fs.mkdir(bin);
      await fs.copyFile(source, script);
      await fs.mkdir(path.join(root, "e2e/shared"), { recursive: true });
      for (const shared of ["targets.ts", "built-in-bundle-id.ts"]) {
        await fs.copyFile(
          fileURLToPath(new URL(`../shared/${shared}`, import.meta.url)),
          path.join(root, "e2e/shared", shared),
        );
      }
      await fs.writeFile(path.join(root, "examples/v0.85.0/e2e.json"), "{}");
      // Records each step; pod install fails on its first run only.
      const tool = (name: string) =>
        `#!${process.execPath}
        const fs = require('node:fs');
        const step = ${JSON.stringify(name)} + ' ' + process.argv.slice(2, 4).join(' ');
        fs.appendFileSync(${JSON.stringify(runs)}, step + '\\n');
        if (step === 'bundle exec pod') {
          const count = fs.readFileSync(${JSON.stringify(runs)}, 'utf8').split('\\n').filter((line) => line === step).length;
          if (count === 1) {
            console.error('Generating Pods project');
            console.error(${JSON.stringify(firstFailure)});
            process.exit(1);
          }
        }`;
      await fs.writeFile(path.join(bin, "bundle"), tool("bundle"), {
        mode: 0o755,
      });
      await fs.writeFile(path.join(bin, "xcodebuild"), tool("xcodebuild"), {
        mode: 0o755,
      });
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [script, "--platform", "ios"], {
            env: { PATH: bin },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, output }));
        },
      );
      const steps = (await fs.readFile(runs, "utf8")).trim().split("\n");
      expect(result.code).toBe(exitCode);
      // The first attempt's output still reaches the job log.
      expect(result.output).toContain(firstFailure);
      expect(steps.filter((step) => step === "bundle exec pod")).toHaveLength(
        podRuns,
      );
      expect(steps.includes("xcodebuild -workspace HotUpdaterExample.xcworkspace")).toBe(
        exitCode === 0,
      );
      const logDir = path.join(root, "e2e/results/native-build");
      if (podRuns === 2) {
        expect(await fs.readdir(logDir)).toEqual([
          "bundle-exec-pod-install-attempt1.log",
        ]);
        expect(
          await fs.readFile(
            path.join(logDir, "bundle-exec-pod-install-attempt1.log"),
            "utf8",
          ),
        ).toBe(`Generating Pods project\n${firstFailure}\n`);
      } else {
        await expect(fs.stat(logDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

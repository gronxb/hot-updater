import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
      env: { NODE_ENV: "production", BABEL_ENV: "production" },
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
    const [install, pods, xcode] = createNativeBuildPlan(
      { platform: "ios", deviceId, dryRun: false },
      "/checkout",
      { HOT_UPDATER_E2E_DEVICE_ID: otherDeviceId },
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
    const [, , xcode] = createNativeBuildPlan(
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
    const [, , xcode] = createNativeBuildPlan(
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
});

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveMobileRuntime, type MobileRuntime } from "./target.ts";

const minBundleId = "00000000-0000-7000-8000-000000000000";

export type NativeBuildOptions = {
  platform: "ios" | "android";
  runtime?: MobileRuntime;
  deviceId?: string;
  dryRun: boolean;
};

export type NativeBuildCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export function parseNativeBuildArgs(
  argv: readonly string[],
): NativeBuildOptions {
  let platform: NativeBuildOptions["platform"] | undefined;
  let deviceId: string | undefined;
  let runtime: MobileRuntime | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (
      arg === "--platform" ||
      arg === "--device" ||
      arg === "--runtime"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--runtime") {
        runtime = resolveMobileRuntime(value, {});
      } else if (arg === "--device") {
        deviceId = value;
      } else if (value === "ios" || value === "android") {
        platform = value;
      } else {
        throw new Error(`Unsupported platform: ${value}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!platform) throw new Error("--platform ios|android is required");
  return { platform, deviceId, dryRun, ...(runtime ? { runtime } : {}) };
}

export function createNativeBuildPlan(
  options: NativeBuildOptions,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NativeBuildCommand[] {
  if (resolveMobileRuntime(options.runtime, env) === "lynx") {
    return [
      {
        command: process.execPath,
        args: [
          "scripts/build-e2e-native.mjs",
          "--platform",
          options.platform,
          "--target",
          "e2e",
        ],
        cwd: path.join(repositoryRoot, "examples/lynx"),
        env: { NODE_ENV: "production", BABEL_ENV: "production" },
      },
    ];
  }
  const cwd = path.join(repositoryRoot, "examples/v0.85.0", options.platform);
  if (options.platform === "android") {
    const architectures =
      env.HOT_UPDATER_E2E_ANDROID_ARCHITECTURES || "arm64-v8a,x86_64";
    return [
      {
        command: "./gradlew",
        args: [
          "--no-daemon",
          ":app:assembleRelease",
          "-Pkotlin.compiler.execution.strategy=in-process",
          `-PreactNativeArchitectures=${architectures}`,
          "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
          `-PMIN_BUNDLE_ID=${minBundleId}`,
        ],
        cwd,
        env: { NODE_ENV: "production", BABEL_ENV: "production" },
      },
    ];
  }

  const deviceId = options.deviceId || env.HOT_UPDATER_E2E_DEVICE_ID;
  if (
    deviceId &&
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(deviceId)
  ) {
    throw new Error("iOS --device must be a simulator UDID");
  }
  const bundlerEnv = {
    BUNDLE_GEMFILE: path.join(repositoryRoot, "examples/v0.85.0/Gemfile"),
    BUNDLE_PATH: path.join(repositoryRoot, "examples/v0.85.0/vendor/bundle"),
    BUNDLE_FROZEN: "1",
  };
  return [
    {
      command: "bundle",
      args: ["install"],
      cwd,
      env: bundlerEnv,
    },
    {
      command: "bundle",
      args: ["exec", "pod", "install"],
      cwd,
      env: {
        ...bundlerEnv,
        RCT_USE_PREBUILT_RNCORE: "1",
        RCT_USE_RN_DEP: "1",
      },
    },
    {
      command: "xcodebuild",
      args: [
        "-workspace",
        "HotUpdaterExample.xcworkspace",
        "-scheme",
        "HotUpdaterExample",
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        deviceId ? `id=${deviceId}` : "generic/platform=iOS Simulator",
        "-derivedDataPath",
        env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH || "build",
        "-quiet",
        `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
      ],
      cwd,
      env: { NODE_ENV: "production", BABEL_ENV: "production" },
    },
  ];
}

async function runCommand(command: NativeBuildCommand): Promise<number> {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    detached: true,
    stdio: "inherit",
  });
  let interruptedExitCode: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    if (interruptedExitCode !== undefined) return;
    interruptedExitCode = signal === "SIGINT" ? 130 : 143;
    stopGroup(signal);
    killTimer = setTimeout(() => stopGroup("SIGKILL"), 5_000);
  };
  const interrupt = () => {
    cancel("SIGINT");
  };
  const terminate = () => {
    cancel("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(interruptedExitCode ?? code ?? 1));
    });
  } finally {
    clearTimeout(killTimer);
    // Bundler, Gradle and Xcode can leave compiler children after their wrapper exits.
    if (interruptedExitCode !== undefined) stopGroup("SIGKILL");
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: pnpm -w e2e:build -- --platform ios|android [--runtime react-native|lynx] [--device <UDID>] [--dry-run]",
    );
    return 0;
  }
  const options = parseNativeBuildArgs(argv);
  const plan = createNativeBuildPlan(
    options,
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  for (const command of plan) {
    const code = await runCommand(command);
    if (code !== 0) return code;
  }
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

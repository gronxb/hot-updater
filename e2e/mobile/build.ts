#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const minBundleId = "00000000-0000-7000-8000-000000000000";

export type NativeBuildOptions = {
  platform: "ios" | "android";
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
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--platform" || arg === "--device") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--device") {
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
  return { platform, deviceId, dryRun };
}

export function createNativeBuildPlan(
  options: NativeBuildOptions,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NativeBuildCommand[] {
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
        env: {},
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
  return [
    {
      command: "bundle",
      args: ["exec", "pod", "install"],
      cwd,
      env: { RCT_USE_PREBUILT_RNCORE: "1", RCT_USE_RN_DEP: "1" },
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
      env: {},
    },
  ];
}

async function runCommand(command: NativeBuildCommand): Promise<number> {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    stdio: "inherit",
  });
  let interruptedExitCode: number | undefined;
  const interrupt = () => {
    interruptedExitCode = 130;
    child.kill("SIGINT");
  };
  const terminate = () => {
    interruptedExitCode = 143;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(interruptedExitCode ?? code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: pnpm -w e2e:build -- --platform ios|android [--device <UDID>] [--dry-run]",
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
  import.meta.url === pathToFileURL(process.argv[1]).href
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

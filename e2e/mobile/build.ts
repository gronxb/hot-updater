#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createE2eMinBundleId } from "../shared/built-in-bundle-id.ts";
import {
  type E2eTarget,
  iosDerivedDataDir,
  loadE2eTarget,
  resolveE2eTargetName,
} from "../shared/targets.ts";

export type NativeBuildOptions = {
  platform: "ios" | "android";
  target: E2eTarget;
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
  env: NodeJS.ProcessEnv = process.env,
): NativeBuildOptions {
  let platform: NativeBuildOptions["platform"] | undefined;
  let target: string | undefined;
  let track: string | undefined;
  let deviceId: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (
      arg === "--platform" ||
      arg === "--device" ||
      arg === "--target" ||
      arg === "--track"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--device") {
        deviceId = value;
      } else if (arg === "--target") {
        target = value;
      } else if (arg === "--track") {
        track = value;
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
  return {
    platform,
    target: loadE2eTarget(resolveE2eTargetName({ target, track }, env)),
    deviceId,
    dryRun,
  };
}

export function createNativeBuildPlan(
  options: NativeBuildOptions,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  minBundleId: string = createE2eMinBundleId(Date.now()),
): NativeBuildCommand[] {
  const { target } = options;
  const appDir = path.join(repositoryRoot, target.appDir);
  const bundleEnv = { NODE_ENV: "production", BABEL_ENV: "production" };
  if (options.platform === "android") {
    const architectures =
      env.HOT_UPDATER_E2E_ANDROID_ARCHITECTURES || "arm64-v8a,x86_64";
    const projectDir = path.join(repositoryRoot, target.android.projectDir);
    if (target.brownfield) {
      const libraryDir = path.join(
        repositoryRoot,
        target.brownfield.libraryAndroidDir,
      );
      return [
        // The library reuses an earlier JavaScript bundle from its build
        // directory, so package from a clean one.
        {
          command: "rm",
          args: ["-rf", target.brownfield.android.libraryBuildDir],
          cwd: libraryDir,
          env: {},
        },
        {
          command: "./gradlew",
          args: [
            "--no-daemon",
            target.brownfield.android.libraryTask,
            "-Pkotlin.compiler.execution.strategy=in-process",
            `-PreactNativeArchitectures=${architectures}`,
            `-PMIN_BUNDLE_ID=${minBundleId}`,
          ],
          cwd: libraryDir,
          env: bundleEnv,
        },
        {
          command: "./gradlew",
          args: [
            "--no-daemon",
            ":app:assembleRelease",
            "-Pkotlin.compiler.execution.strategy=in-process",
            "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
          ],
          cwd: projectDir,
          env: {},
        },
      ];
    }
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
        cwd: projectDir,
        env: bundleEnv,
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
  const podsDir = path.join(repositoryRoot, target.ios.podsDir);
  const projectDir = path.join(repositoryRoot, target.ios.projectDir);
  const bundlerEnv = {
    BUNDLE_GEMFILE: path.join(appDir, "Gemfile"),
    BUNDLE_PATH: path.join(appDir, "vendor/bundle"),
    BUNDLE_FROZEN: "1",
  };
  const destination = deviceId
    ? `id=${deviceId}`
    : "generic/platform=iOS Simulator";
  const dependencies: NativeBuildCommand[] = [
    {
      command: "bundle",
      args: ["install"],
      cwd: podsDir,
      env: bundlerEnv,
    },
    {
      command: "bundle",
      args: ["exec", "pod", "install"],
      cwd: podsDir,
      env: { ...bundlerEnv, ...target.ios.podEnv },
    },
  ];
  if (target.brownfield) {
    const derivedData = iosDerivedDataDir(target, repositoryRoot, env);
    return [
      ...dependencies,
      // Writes the XCFrameworks to the app's ios/.brownfield/package/build,
      // where the host project links them.
      {
        command: path.join(appDir, "node_modules/.bin/brownfield"),
        args: [
          "package:ios",
          "--scheme",
          target.brownfield.ios.frameworkScheme,
          "--configuration",
          "Release",
          // Device and simulator, as the guide packages: the CLI merges both.
          "--no-install-pods",
          "--build-folder",
          path.join(derivedData, "framework"),
          "--extra-params",
          `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
        ],
        cwd: appDir,
        env: bundleEnv,
      },
      {
        command: "xcodebuild",
        args: [
          "-project",
          target.brownfield.ios.hostProject,
          "-scheme",
          target.brownfield.ios.hostScheme,
          "-configuration",
          "Release",
          "-sdk",
          "iphonesimulator",
          "-destination",
          destination,
          "-derivedDataPath",
          derivedData,
          "-quiet",
        ],
        cwd: projectDir,
        env: {},
      },
    ];
  }
  return [
    ...dependencies,
    {
      command: "xcodebuild",
      args: [
        "-workspace",
        target.ios.workspace,
        "-scheme",
        target.ios.scheme,
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-destination",
        destination,
        "-derivedDataPath",
        env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH || "build",
        "-quiet",
        `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
      ],
      cwd: projectDir,
      env: bundleEnv,
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
      "Usage: pnpm -w e2e:build -- --platform ios|android [--target <example>] [--device <UDID>] [--dry-run]",
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

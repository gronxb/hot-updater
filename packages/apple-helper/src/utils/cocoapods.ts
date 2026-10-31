import fs from "fs";
import path from "path";

import {
  BuildFailedError,
  BuildLogger,
  getCwd,
  getReactNativeMetadatas,
  p,
} from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { formatCommand } from "./formatCommand";

/** What `installPodsIfNeeded` ran. */
export interface PodInstallSteps {
  /** React Native codegen, before `pod install`. */
  readonly codegen: boolean;
  /** `pod install`, which a project without a Podfile skips. */
  readonly pods: boolean;
}

/** The last lines of a failed command's output, which say why. */
const OUTPUT_TAIL_LINES = 12;

/**
 * A failed command's error: the command, then the last lines of its
 * output, stdout and stderr as printed, without execa's full message.
 */
const commandFailure = (command: string, error: unknown): Error => {
  const { all, stderr, stdout } = (error ?? {}) as {
    all?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const output = String(
    all || [stdout, stderr].filter(Boolean).join("\n") || "",
  ).trimEnd();
  const tail = output
    .split("\n")
    .filter((line) => line.trim())
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n");
  const detail =
    tail || (error instanceof Error ? error.message : String(error));
  return new Error(`${command} failed.\n${detail}`, { cause: error });
};

/**
 * A line of the progress meter curl prints on stderr for each pod it
 * downloads, such as React Native's prebuilt core.
 */
const DOWNLOAD_PROGRESS = [
  /^% Total +% Received/,
  /^Dload +Upload/,
  /^\d{1,3} +[\d.]+[kMGT]? +\d{1,3} +[\d.]+[kMGT]? /,
];

/**
 * `pod install`'s output: its live line shows the pod it installs, its log
 * keeps the whole output, and a failure prints CocoaPods' `[!]` errors and a
 * crash's `SomeError - …` line with its last lines, without the download
 * progress CocoaPods' curl prints on stderr.
 */
const createPodInstallLogger = () =>
  new BuildLogger({
    logPrefix: "pod-install",
    createPhaseReader: () => (line) => {
      const installing = /^Installing (\S+)/.exec(line);
      if (installing) return `Installing ${installing[1]}`;
      return /^(Analyzing dependencies|Downloading dependencies|Generating Pods project|Integrating client project)$/.test(
        line,
      )
        ? line
        : undefined;
    },
    failureSummary: {
      // A crash's exception, which CocoaPods prints in its issue template.
      lines: [/^[A-Z]\w*(::\w+)*Error - /],
      // An error and the lines that explain it, such as the pods whose
      // versions conflict.
      blocks: [{ start: /^\[!\] /, end: /^$/, includeEnd: false }],
      ignore: DOWNLOAD_PROGRESS,
      tail: 4,
      // A crash's report ends here; links to CocoaPods' issues follow.
      stopAfter: /^\[!\] Oh no, an error occurred\.$/,
      maxWidth: 76,
    },
  });

/**
 * Runs `pod install` as a step whose failure prints CocoaPods' errors and
 * the log's path, then throws a `BuildFailedError`.
 */
const runPodInstall = async ({
  command,
  env,
  sourceDir,
}: {
  command: string[];
  env: Record<string, string>;
  sourceDir: string;
}): Promise<void> => {
  const logger = createPodInstallLogger();
  const failureMessage = `${command.join(" ")} failed`;
  await logger.start({
    title: "Installing CocoaPods dependencies",
    header: [
      `$ ${formatCommand([
        ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
        ...command,
      ])}`,
      "",
    ],
  });
  try {
    const podProcess = execa(command[0]!, command.slice(1), {
      cwd: sourceDir,
      env,
      all: true,
      // The output streams to the log file; buffered, it would fill the
      // error's message.
      buffer: false,
    });
    const logging = podProcess.all
      ? logger.processStream(podProcess.all)
      : Promise.resolve();
    // Settled together: pod exits before the log finishes reading its
    // output, and its failure must wait for it.
    const [podResult, loggingResult] = await Promise.allSettled([
      podProcess,
      logging,
    ]);
    if (podResult.status === "rejected") throw podResult.reason;
    if (loggingResult.status === "rejected") throw loggingResult.reason;
    logger.stop("CocoaPods dependencies installed");
  } catch (error) {
    logger.writeError(error);
    const reason =
      error instanceof ExecaError && error.exitCode !== undefined
        ? `exited with code ${error.exitCode}`
        : error instanceof Error
          ? error.message
          : String(error);
    logger.stop(`${failureMessage} · ${reason}`, false);
    throw new BuildFailedError(`${failureMessage}: ${reason}`, {
      logPath: logger.logPath,
      summary: logger.failureSummary,
      cause: error,
    });
  } finally {
    await logger.close();
  }
};

export const installPodsIfNeeded = async (
  sourceDir: string,
): Promise<PodInstallSteps> => {
  const podfilePath = path.join(sourceDir, "Podfile");

  // Check if Podfile exists
  const fileExist = fs.existsSync(podfilePath);

  if (!fileExist) {
    p.log.info("No Podfile found, skipping CocoaPods installation");
    return { codegen: false, pods: false };
  }

  const gemfilePaths = [
    path.join(sourceDir, "Gemfile"),
    path.join(getCwd(), "Gemfile"),
  ];
  const shouldUseBundler = (
    await Promise.all(gemfilePaths.map(checkShouldUseBundler))
  ).some(Boolean);

  const reactNative = getReactNativeMetadatas();
  const plan = resolvePodInstallPlan({
    version: reactNative.version,
    env: process.env,
  });

  if (plan.runCodegen) {
    await runReactNativeCodegen({
      projectRoot: getCwd(),
      reactNativePath: reactNative.packagePath,
      sourceDir,
    });
  }

  if (shouldUseBundler) {
    const bundleSpinner = p.spinner();
    bundleSpinner.start("Installing Ruby gems");
    try {
      await execa("bundle", ["install"], { cwd: sourceDir, all: true });
    } catch (error) {
      bundleSpinner.error("bundle install failed");
      throw commandFailure("bundle install", error);
    }
    bundleSpinner.stop("Ruby gems installed");
  }

  const podCommand = shouldUseBundler
    ? ["bundle", "exec", "pod", "install"]
    : ["pod", "install"];
  await runPodInstall({ command: podCommand, env: plan.env, sourceDir });
  return { codegen: plan.runCodegen, pods: true };
};

const checkShouldUseBundler = async (gemfilePath: string): Promise<boolean> => {
  try {
    if (!fs.existsSync(gemfilePath)) {
      return false;
    }

    const gemfileContent = await fs.promises.readFile(gemfilePath, "utf-8");
    return gemfileContent.includes("cocoapods");
  } catch {
    return false;
  }
};

/**
 * Runs React Native codegen into `<sourceDir>/build/generated/ios`, as the
 * React Native CLI does before `pod install`. Clearing the old output first
 * drops the modules of removed libraries.
 */
const runReactNativeCodegen = async ({
  projectRoot,
  reactNativePath,
  sourceDir,
}: {
  projectRoot: string;
  reactNativePath: string;
  sourceDir: string;
}): Promise<void> => {
  await fs.promises.rm(path.join(sourceDir, "build", "generated", "ios"), {
    recursive: true,
    force: true,
  });

  const spinner = p.spinner();
  spinner.start("Running React Native codegen");
  try {
    await execa(
      "node",
      [
        path.join(reactNativePath, "scripts", "generate-codegen-artifacts.js"),
        "-p",
        projectRoot,
        "-o",
        sourceDir,
        "-t",
        "ios",
      ],
      { cwd: projectRoot, all: true },
    );
  } catch (error) {
    spinner.error("React Native codegen failed");
    throw commandFailure("React Native codegen", error);
  }
  spinner.stop("React Native codegen done");
};

/**
 * The environment `pod install` runs with, and whether codegen runs first.
 *
 * From React Native 0.79, `RCT_IGNORE_PODS_DEPRECATION=1` silences the
 * deprecation notice for calling `pod install` directly and also sets
 * `RCT_SKIP_CODEGEN=1`, because the React Native CLI runs codegen itself
 * first. Hot Updater sets it the same way and runs codegen too, unless the
 * user's `RCT_SKIP_CODEGEN=1` takes codegen over. Before 0.79, and when the
 * version is unknown, CocoaPods runs codegen. A user's value of a flag wins.
 */
export const resolvePodInstallPlan = ({
  version,
  env,
}: {
  version: { major: number; minor: number };
  env: NodeJS.ProcessEnv;
}): { env: Record<string, string>; runCodegen: boolean } => {
  const podsSkipCodegen = version.major > 0 || version.minor >= 79;
  const usePrebuiltReactNative = version.major > 0 || version.minor >= 81;
  const ignorePodsDeprecation =
    env["RCT_IGNORE_PODS_DEPRECATION"] ?? (podsSkipCodegen ? "1" : undefined);

  return {
    runCodegen:
      podsSkipCodegen &&
      ignorePodsDeprecation === "1" &&
      env["RCT_SKIP_CODEGEN"] !== "1",
    env: {
      ...(ignorePodsDeprecation !== undefined && {
        RCT_IGNORE_PODS_DEPRECATION: ignorePodsDeprecation,
      }),
      RCT_USE_RN_DEP:
        env["RCT_USE_RN_DEP"] ?? (usePrebuiltReactNative ? "1" : "0"),
      RCT_USE_PREBUILT_RNCORE:
        env["RCT_USE_PREBUILT_RNCORE"] ?? (usePrebuiltReactNative ? "1" : "0"),
    },
  };
};

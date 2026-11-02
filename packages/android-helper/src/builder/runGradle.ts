import fs from "fs";
import path from "path";

import { BuildFailedError, getCwd, p } from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { createGradleLogger } from "../utils/createGradleLogger";
import { formatCommand } from "../utils/formatCommand";

type RunGradleArgs = {
  tasks: string[];
  logPrefix: string;
  appModuleName: string;
  args: { extraParams?: string[]; port?: string | number };
  /** Added to the Gradle environment, for values kept off the command line. */
  env?: Record<string, string>;
  androidProjectPath: string;
  /** Lines the build log starts with, such as the native build key. */
  logHeader?: string[];
};

/** Why Gradle failed, without its command line. */
const describeFailure = (error: unknown) => {
  if (error instanceof ExecaError) {
    if (error.signal) return `Gradle was stopped by ${error.signal}.`;
    if (error.exitCode !== undefined) {
      return `Gradle exited with code ${error.exitCode}.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Generate gradle task names with module prefix
 */
function getTaskNames(moduleName: string, tasks: string[]): Array<string> {
  return tasks.map((task) => `${moduleName}:${task}`);
}

/**
 * Get gradle wrapper command based on platform
 */
const getGradleWrapper = () =>
  process.platform.startsWith("win") ? "gradlew.bat" : "./gradlew";

/** A variable a POSIX shell can't name, as the signing environment's are. */
const isShellName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/**
 * The command that runs the wrapper with `env`. The wrapper's `#!/bin/sh` is
 * dash on Debian and Ubuntu, which silently drops a variable whose name isn't
 * a shell name, such as `ORG_GRADLE_PROJECT_android.injected.signing.store.file`:
 * the build then signs with the project's own config. bash keeps them.
 */
const gradleCommand = (
  env: Record<string, string> | undefined,
): [string, string[]] => {
  const wrapper = getGradleWrapper();
  return wrapper === "./gradlew" &&
    Object.keys(env ?? {}).some((name) => !isShellName(name))
    ? ["bash", [wrapper]]
    : [wrapper, []];
};

/**
 * Run gradle build with specified tasks and arguments
 */
export async function runGradle(args: RunGradleArgs): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** The build log, or null without one. */
  logFilePath: string | null;
}> {
  const logFilePath = await runGradleTasks(args);
  return {
    ...(await findBuildDirectory({
      androidProjectPath: args.androidProjectPath,
      moduleName: args.appModuleName,
      tasks: args.tasks,
    })),
    logFilePath,
  };
}

/** Runs tasks that leave no artifact to find, and returns the build log, or null. */
export async function runGradleTasks({
  tasks,
  logPrefix,
  args,
  env,
  androidProjectPath,
  appModuleName,
  logHeader = [],
}: RunGradleArgs): Promise<string | null> {
  const gradleArgs = getTaskNames(appModuleName, tasks);

  gradleArgs.push("-x", "lint");

  if (args.extraParams) {
    gradleArgs.push(...args.extraParams);
  }

  if ("port" in args && args.port != null) {
    gradleArgs.push(`-PreactNativeDevServerPort=${args.port}`);
  }

  const logger = createGradleLogger({ logPrefix });
  await logger.start({
    title: `Building ${tasks.join(", ")}`,
    header: [
      ...logHeader,
      `Project     ${path.relative(getCwd(), androidProjectPath) || "."}`,
      `App module  ${appModuleName}`,
      `Tasks       ${tasks.join(", ")}`,
      `$ ${formatCommand([path.basename(getGradleWrapper()), ...gradleArgs])}`,
      "",
    ],
  });
  let logFilePath: string | null = null;

  try {
    const [command, prefix] = gradleCommand(env);
    const gradle = execa(command, [...prefix, ...gradleArgs], {
      cwd: androidProjectPath,
      env,
      all: true,
      // The output streams to the log file; buffered, it would fill the
      // error's message.
      buffer: false,
    });
    const outputStream = gradle.all ?? gradle.stdout;
    // Settled together: Gradle exits before the log finishes reading its
    // output, and its failure must wait for it.
    const [gradleResult, loggingResult] = await Promise.allSettled([
      gradle,
      outputStream ? logger.processStream(outputStream) : undefined,
    ]);
    if (gradleResult.status === "rejected") throw gradleResult.reason;
    if (loggingResult.status === "rejected") throw loggingResult.reason;

    logger.stop(`Built ${tasks.join(", ")}`);
    logFilePath = logger.logFilePath;
  } catch (e) {
    logger.writeError(e);
    const reason = describeFailure(e);
    // One line says the build failed and why: `Build failed · Gradle exited
    // with code 1`.
    logger.stop(`Build failed · ${reason.replace(/\.$/, "")}`, false);
    throw new BuildFailedError(`Build failed: ${reason}`, {
      logPath: logger.logPath,
      summary: logger.failureSummary,
      cause: e,
    });
  } finally {
    await logger.close();
  }

  return logFilePath;
}

/**
 * Find the build output directory and artifact path
 */
async function findBuildDirectory({
  moduleName,
  tasks,
  androidProjectPath,
}: {
  moduleName: string;
  tasks: string[];
  androidProjectPath: string;
}): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
}> {
  const selectedTask = tasks.find(
    (t) =>
      t.startsWith("install") ||
      t.startsWith("assemble") ||
      t.startsWith("bundle"),
  );
  if (!selectedTask) {
    throw new Error(`Not supported gradle task: ${tasks.join(", ")}`);
  }
  // handle if selected task includes build flavour as well, eg. installProductionDebug should create ['production','debug'] array
  const variantFromSelectedTask = selectedTask
    ?.replace("install", "")
    ?.replace("assemble", "")
    ?.replace("bundle", "")
    .split(/(?=[A-Z])/);

  // create path to output file, eg. `production/debug`
  const variantPath = variantFromSelectedTask?.join("/")?.toLowerCase();
  // create output file name, eg. `production-debug`
  const variant = variantFromSelectedTask?.join("-")?.toLowerCase();
  const isAabOutput = selectedTask?.includes("bundle") === true;
  const buildDirectory = `${androidProjectPath}/${moduleName}/build/outputs/${isAabOutput ? "bundle" : "apk"}/${variantPath}`;

  if (!buildDirectory) {
    throw new Error("Failed to find Android gradle build directory.");
  }

  const buildArtifactPath = await getBuildOutputFilePath({
    aab: isAabOutput,
    appModuleName: moduleName,
    buildDirectory,
    variant,
  });

  return { buildDirectory, buildArtifactPath };
}

/**
 * Get the path to the build output file (APK or AAB)
 */
async function getBuildOutputFilePath({
  aab,
  appModuleName,
  buildDirectory,
  variant,
}: {
  appModuleName: string;
  variant: string;
  buildDirectory: string;
  aab: boolean;
}) {
  // we don't check abi specific output file yet
  // check if there is an apk file like app-armeabi-v7a-debug.apk
  // for (const availableCPU of availableCPUs.concat("universal")) {
  //   const outputFile = `${appModuleName}-${availableCPU}-${variant}.${apkOrAab}`;
  //   if (existsSync(`${buildDirectory}/${outputFile}`)) {
  //     return outputFile;
  //   }
  // }

  // check if there is a default file like app-debug.apk
  const outputFile = `${appModuleName}-${variant}.${aab ? "aab" : "apk"}`;
  const outputFilePath = path.join(buildDirectory, outputFile);
  if (fs.existsSync(outputFilePath)) {
    return outputFilePath;
  }

  p.log.error(`Gradle wrote no ${outputFilePath}.`);
  process.exit(1);
}

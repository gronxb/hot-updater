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

/**
 * Run gradle build with specified tasks and arguments
 */
export async function runGradle({
  tasks,
  logPrefix,
  args,
  env,
  androidProjectPath,
  appModuleName,
  logHeader = [],
}: RunGradleArgs): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** The build log, or null without one. */
  logFilePath: string | null;
}> {
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
    const gradle = execa(getGradleWrapper(), gradleArgs, {
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
    logger.stop("Build failed", false);
    throw new BuildFailedError(`Build failed: ${describeFailure(e)}`, {
      logPath: logger.logPath,
      summary: logger.failureSummary,
      cause: e,
    });
  } finally {
    await logger.close();
  }

  return {
    ...(await findBuildDirectory({
      androidProjectPath,
      moduleName: appModuleName,
      tasks,
    })),
    logFilePath,
  };
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

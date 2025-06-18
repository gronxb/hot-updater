/* highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android/src/lib/commands/runGradle.ts */
import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import { ExecaError, execa } from "execa";

export type RunGradleArgs = {
  tasks: string[];
  appModuleName: string;
  args: { extraParams?: string[]; port?: string | number };
  artifactName: string;
  androidProjectPath: string;
};

const getCleanedErrorMessage = (error: ExecaError) => {
  const gradleLinesToRemove = [
    "FAILURE: Build failed with an exception.",
    "* Try:",
    "> Run with --stacktrace option to get the stack trace.",
    "> Run with --info or --debug option to get more log output.",
    "> Run with --scan to get full insights.",
    "> Get more help at [undefined](https://help.gradle.org).",
    "> Get more help at https://help.gradle.org.",
    "BUILD FAILED",
  ];
  return error.message
    .split("\n")
    .filter(
      (line: string) => !gradleLinesToRemove.some((l) => line.includes(l)),
    )
    .join("\n")
    .trim();
};

function getTaskNames(moduleName: string, tasks: string[]): Array<string> {
  return tasks.map((task) => `${moduleName}:${task}`);
}

const getGradleWrapper = () =>
  process.platform.startsWith("win") ? "gradlew.bat" : "./gradlew";

export async function runGradle({
  tasks,
  args,
  androidProjectPath,
  appModuleName,
}: RunGradleArgs) {
  p.log.info(`Run Gradle Settings: 
Project    ${androidProjectPath}
App Moudle ${appModuleName}
Tasks      ${tasks.join(", ")}
`);

  const gradleArgs = getTaskNames(appModuleName, tasks);

  gradleArgs.push("-x", "lint");

  if (args.extraParams) {
    gradleArgs.push(...args.extraParams);
  }

  if ("port" in args && args.port != null) {
    gradleArgs.push(`-PreactNativeDevServerPort=${args.port}`);
  }

  try {
    await execa(getGradleWrapper(), gradleArgs, {
      cwd: androidProjectPath,
    });
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(getCleanedErrorMessage(e));
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }

    throw new Error(
      "Faild to build the app. See the error above for details from Gradle.",
    );
  }

  const outputFilePath = await findOutputFile({
    androidProjectPath,
    moduleName: appModuleName,
    tasks,
  });
  // if (outputFilePath) {
  //   saveLocalBuildCache(artifactName, outputFilePath);
  // }
}

async function findOutputFile({
  moduleName,
  tasks,
  androidProjectPath,
}: { moduleName: string; tasks: string[]; androidProjectPath: string }) {
  const selectedTask = tasks.find(
    (t) =>
      t.startsWith("install") ||
      t.startsWith("assemble") ||
      t.startsWith("bundle"),
  );
  if (!selectedTask) {
    return false;
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

  const outputPath = await getOutputFilePath({
    aab: isAabOutput,
    appModuleName: moduleName,
    buildDirectory,
    variant,
  });
  p.log.info(`Output file: ${outputPath}`);
  return outputPath ?? null;
}

async function getOutputFilePath({
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

  p.log.error(`Failed to find the output file for ${outputFilePath}`);
  process.exit(1);
}

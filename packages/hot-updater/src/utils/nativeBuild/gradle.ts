/* highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android/src/lib/commands/runGradle.ts */
import fs from "fs";
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
  artifactName,
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
  const variantAppName = variantFromSelectedTask?.join("-")?.toLowerCase();
  const apkOrBundle = selectedTask?.includes("bundle") ? "bundle" : "apk";
  const buildDirectory = `${androidProjectPath}/${moduleName}/build/outputs/${apkOrBundle}/${variantPath}`;

  p.log.info(fs.readdirSync(buildDirectory).join(", "));
  // const outputFile = await getInstallOutputFileName(
  //   appName,
  //   variantAppName,
  //   buildDirectory,
  //   apkOrBundle === "apk" ? "apk" : "aab",
  //   device,
  // );
  // return outputFile ? `${buildDirectory}/${outputFile}` : undefined;
}

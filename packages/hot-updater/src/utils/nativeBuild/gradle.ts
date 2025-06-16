import path from "path";
import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";

export type RunGradleArgs = {
  tasks: string[];
  moduleName: string;
  args: { extraParams?: string[]; port?: string | number };
  artifactName: string;
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
  moduleName,
  artifactName,
}: RunGradleArgs) {
  p.log.info(`Run Gradle Settings: 
App Moudle ${moduleName}
Tasks      ${tasks.join(", ")}
`);

  const loader = p.spinner({ indicator: "timer" });
  const message = "Building the app";

  loader.start(message);
  const gradleArgs = getTaskNames(moduleName, tasks);

  gradleArgs.push("-x", "lint");

  if (args.extraParams) {
    gradleArgs.push(...args.extraParams);
  }

  if ("port" in args && args.port != null) {
    gradleArgs.push(`-PreactNativeDevServerPort=${args.port}`);
  }

  try {
    await execa(getGradleWrapper(), gradleArgs, {
      cwd: path.join(getCwd(), "android"),
    });
    loader.stop("Built the app");
  } catch (e) {
    loader.stop("Failed to build the app");
    if (e instanceof ExecaError) {
      p.log.error(getCleanedErrorMessage(e));
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }

    throw new Error(
      "Faild to build the app. See the error above for details from Gradle.",
    );
  }

  // const outputFilePath = await findOutputFile(androidProject, tasks);
  // if (outputFilePath) {
  //   saveLocalBuildCache(artifactName, outputFilePath);
  // }
}

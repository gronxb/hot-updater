export type RunGradleArgs = {
  tasks: string[];
  androidProject: AndroidProject;
  args: BuildFlags | Flags;
  artifactName: string;
};

const getCleanedErrorMessage = (error: SubprocessError) => {
  return error.stderr
    .split("\n")
    .filter((line) => !gradleLinesToRemove.some((l) => line.includes(l)))
    .join("\n")
    .trim();
};

const GRADLE_WRAPPER = process.platform.startsWith("win")
  ? "gradlew.bat"
  : "./gradlew";

export async function runGradle({
  tasks,
  androidProject,
  args,
  artifactName,
}: RunGradleArgs) {
  const humanReadableTasks = tasks.join(", ");

  logger.log(`Build Settings:
Variant   ${color.bold(args.variant)}
Tasks     ${color.bold(humanReadableTasks)}`);

  const loader = spinner({ indicator: "timer" });
  const message = `Building the app`;

  loader.start(message);
  const gradleArgs = getTaskNames(androidProject.appName, tasks);

  gradleArgs.push("-x", "lint");

  if (args.extraParams) {
    gradleArgs.push(...args.extraParams);
  }

  if ("port" in args && args.port != null) {
    gradleArgs.push("-PreactNativeDevServerPort=" + args.port);
  }

  const gradleWrapper = getGradleWrapper();

  try {
    await execa(gradleWrapper, gradleArgs, { cwd: androidProject.sourceDir });
    loader.stop(`Built the app`);
  } catch (error) {
    loader.stop("Failed to build the app");
    const cleanedErrorMessage = getCleanedErrorMessage(
      error as SubprocessError,
    );

    if (cleanedErrorMessage) {
      logger.error(cleanedErrorMessage);
    }

    const hints = getErrorHints((error as SubprocessError).stdout ?? "");
    throw new RnefError(
      hints ||
        "Failed to build the app. See the error above for details from Gradle.",
    );
  }

  const outputFilePath = await findOutputFile(androidProject, tasks);
  if (outputFilePath) {
    saveLocalBuildCache(artifactName, outputFilePath);
  }
}

function getErrorHints(output: string) {
  const signingMessage = output.includes("validateSigningRelease FAILED")
    ? `Hint: You can run "${color.bold(
        "rnef create-keystore:android",
      )}" to create a keystore file.`
    : "";
  return signingMessage;
}

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

function getTaskNames(appName: string, tasks: string[]): Array<string> {
  return tasks.map((task) => `${appName}:${task}`);
}

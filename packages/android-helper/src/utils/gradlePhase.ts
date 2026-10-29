import type { BuildPhaseReader } from "@hot-updater/cli-tools";

/** `> Task :app:compileReleaseKotlin`, with an outcome such as `UP-TO-DATE`. */
const TASK = /^> Task (:\S+)/;

const CONFIGURE = /^> Configure project (:\S*)/;

/**
 * Reads the phase of a Gradle build from its plain console output: the
 * task it runs, after how many it has run, such as
 * `312 tasks · :app:mergeReleaseResources`.
 */
export const createGradlePhaseReader = (): BuildPhaseReader => {
  let tasks = 0;
  return (line) => {
    const task = TASK.exec(line)?.[1];
    if (task) {
      tasks += 1;
      // The count first: a long task name is what a narrow line cuts.
      return `${tasks} task${tasks === 1 ? "" : "s"} · ${task}`;
    }
    const project = CONFIGURE.exec(line)?.[1];
    if (project) return `Configuring ${project}`;
    if (line.startsWith("Starting a Gradle Daemon")) {
      return "Starting the Gradle daemon";
    }
    if (line.startsWith("Downloading https://services.gradle.org/")) {
      return "Downloading Gradle";
    }
    return undefined;
  };
};

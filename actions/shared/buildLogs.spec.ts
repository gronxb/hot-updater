import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBuildLogs } from "./cli.mjs";

describe("createBuildLogs", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "build-logs-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("lists the logs written in the working directory since the build started", async () => {
    const logDir = path.join(
      workspace,
      "apps",
      "mobile",
      ".hot-updater",
      "log",
    );
    await fs.mkdir(logDir, { recursive: true });
    const earlier = path.join(logDir, "10261100-android-release-build.log");
    await fs.writeFile(earlier, "an earlier step's build");
    const since = Date.now() - 1000;
    await fs.utimes(
      earlier,
      new Date(since - 60_000),
      new Date(since - 60_000),
    );
    const ios = path.join(logDir, "10261157-ios-simulator-build.log");
    await fs.writeFile(ios, "error: cannot find 'missingSymbol' in scope");

    const buildLogs = createBuildLogs({
      actionEnv: {
        GITHUB_WORKSPACE: workspace,
        INPUT_WORKING_DIRECTORY: "apps/mobile",
      },
    });

    expect(buildLogs(since)).toEqual([ios]);
  });

  it("lists none without a log directory", () => {
    const buildLogs = createBuildLogs({
      actionEnv: { GITHUB_WORKSPACE: workspace },
    });

    expect(buildLogs(0)).toEqual([]);
  });
});

const readAction = (name: string) =>
  fs.readFile(path.join(import.meta.dirname, "..", name, "action.yml"), "utf8");

/** The composite steps after the `run` step, each as its lines. */
const stepsAfterRun = (action: string) =>
  action
    .slice(action.indexOf("    - id: run"))
    .split(/\n(?= {4}- )/)
    .slice(1);

describe.each([
  [
    "native-build",
    ["build-log"],
    () => "hot-updater-build-log-${{ inputs.platform }}-${{ inputs.scheme }}",
  ],
  [
    "preview",
    ["ios-build-log", "android-build-log"],
    (output: string) =>
      `hot-updater-preview-build-log-${output.replace("-build-log", "")}`,
  ],
])("%s action.yml", (name, outputs, artifactName) => {
  it("uploads each failed build's log as an artifact, with a pinned upload-artifact", async () => {
    const action = await readAction(name);
    const steps = stepsAfterRun(action);

    expect(steps).toHaveLength(outputs.length);
    outputs.forEach((output, index) => {
      const step = steps[index]!;
      expect(step).toContain(
        `- if: failure() && steps.run.outputs.${output} != ''`,
      );
      // Pinned by commit, as every action the repository uses.
      expect(step).toMatch(
        /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/,
      );
      expect(step).toContain(`name: ${artifactName(output)}\n`);
      expect(step).toContain(`path: \${{ steps.run.outputs.${output} }}`);
      // The log is in .hot-updater, which upload-artifact skips by default.
      expect(step).toContain("include-hidden-files: true");
      // A re-run of the job uploads it again.
      expect(step).toContain("overwrite: true");
      // The action's output, beside the step's.
      expect(action).toContain(
        `  ${output}:\n    description: >-\n      When the`,
      );
      expect(action).toContain(`value: \${{ steps.run.outputs.${output} }}`);
    });
  });
});

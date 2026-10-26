import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runGradle } from "./runGradle";

// What Gradle prints when a task fails: tasks and warnings, the compiler's
// errors, then the "What went wrong" block.
const FAKE_GRADLEW = `#!/bin/sh
echo "> Configure project :app"
i=0
while [ $i -lt 200 ]; do
  echo "> Task :app:task$i"
  echo "w: file:///src/Lib.kt:$i:1 'value' is deprecated."
  i=$((i + 1))
done
echo "e: file:///src/App.kt:12:5 Unresolved reference 'missingSymbol'."
echo ""
echo "FAILURE: Build failed with an exception."
echo ""
echo "* What went wrong:"
echo "Execution failed for task ':app:compileReleaseKotlin'."
echo "> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers\\$GradleKotlinCompilerWorkAction"
echo "   > Compilation error. See log for more details"
echo ""
echo "* Try:"
echo "> Run with --stacktrace option to get the stack trace."
echo ""
echo "BUILD FAILED in 12s"
echo "last line of gradle"
exit 1
`;

let projectDir: string;
let androidDir: string;
let stderr: string;

beforeEach(async () => {
  // The log lands in the nearest package root's .hot-updater/log.
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gradle-log-"));
  await fs.writeFile(path.join(projectDir, "package.json"), "{}");
  androidDir = path.join(projectDir, "android");
  await fs.mkdir(androidDir);
  await fs.writeFile(path.join(androidDir, "gradlew"), FAKE_GRADLEW, {
    mode: 0o755,
  });
  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(projectDir, { recursive: true, force: true });
});

const runFailingGradle = async () => {
  const error = await runGradle({
    tasks: ["assembleRelease"],
    logPrefix: "android-release-build",
    appModuleName: "app",
    args: {},
    androidProjectPath: androidDir,
  }).then(
    () => {
      throw new Error("Expected the build to fail.");
    },
    (reason: unknown) => reason,
  );
  return error as Error & { logPath: string | null; summary: string[] };
};

it("prints Gradle's errors and the log's path, not its whole output", async () => {
  const error = await runFailingGradle();

  expect(error.name).toBe("BuildFailedError");
  expect(error.message).toBe("Build failed: Gradle exited with code 1.");
  expect(error.logPath).toMatch(
    /^\.hot-updater\/log\/\d{8}-android-release-build\.log$/,
  );
  expect(error.summary).toEqual([
    "e: file:///src/App.kt:12:5 Unresolved reference 'missingSymbol'.",
    "* What went wrong:",
    "Execution failed for task ':app:compileReleaseKotlin'.",
    "> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction",
    "   > Compilation error. See log for more details",
    "",
    "BUILD FAILED in 12s",
  ]);
  expect(stderr).toContain("Unresolved reference 'missingSymbol'");
  expect(stderr).toContain("* What went wrong:");
  expect(stderr).toContain(`Build log: ${error.logPath}`);
  expect(stderr).not.toContain("> Task :app:task0");
  expect(stderr).not.toContain("is deprecated");
});

it("keeps Gradle's whole output in the log, through its last line", async () => {
  await runFailingGradle();

  const logDir = path.join(projectDir, ".hot-updater", "log");
  const [logFile] = await fs.readdir(logDir);
  const log = await fs.readFile(path.join(logDir, String(logFile)), "utf8");
  expect(log).toContain("> Task :app:task0\n");
  expect(log).toContain(
    "e: file:///src/App.kt:12:5 Unresolved reference 'missingSymbol'.",
  );
  // Through Gradle's last line, then the failure.
  expect(log).toMatch(/last line of gradle\n[^]*exit code 1/);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runXcodebuildWithLogging } from "./runXcodebuildWithLogging";

// What xcodebuild prints when a build fails: the command line and the target
// dependency graph first, then warnings, the error, and the failure block.
const FAKE_XCODEBUILD = `#!/bin/sh
echo "Command line invocation:"
echo "    /usr/bin/xcodebuild $*"
echo "note: Building targets in dependency order"
echo "note: Target dependency graph (2 targets)"
echo "    Target 'App' in project 'App'"
i=0
while [ $i -lt 200 ]; do
  echo "/src/Pods/Lib.swift:$i:1: warning: use of protocol 'Record' as a type; this will be an error in a future Swift language mode"
  i=$((i + 1))
done
echo "/src/App/AppDelegate.swift:12:5: error: cannot find 'missingSymbol' in scope"
echo "** BUILD FAILED **"
echo ""
echo "The following build commands failed:"
echo "	SwiftCompile normal arm64 /src/App/AppDelegate.swift (in target 'App' from project 'App')"
echo "(1 failure)"
echo "last line of xcodebuild"
exit 65
`;

const ERROR_LINE =
  "/src/App/AppDelegate.swift:12:5: error: cannot find 'missingSymbol' in scope";

let projectDir: string;
let binDir: string;
let stderr: string;
let stdout: string;
const originalPath = process.env["PATH"];

const writeExecutable = async (name: string, content: string) => {
  const file = path.join(binDir, name);
  await fs.writeFile(file, content, { mode: 0o755 });
};

beforeEach(async () => {
  // The log lands in the nearest package root's .hot-updater/log.
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "xcodebuild-log-"));
  await fs.writeFile(path.join(projectDir, "package.json"), "{}");
  binDir = path.join(projectDir, "bin");
  await fs.mkdir(binDir);
  await writeExecutable("xcodebuild", FAKE_XCODEBUILD);
  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  // Nothing else from the machine's PATH.
  process.env["PATH"] = `${binDir}:/usr/bin:/bin`;
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env["PATH"] = originalPath;
  await fs.rm(projectDir, { recursive: true, force: true });
});

const runBuild = () =>
  runXcodebuildWithLogging({
    args: ["-scheme", "App", "-authenticationKeyPath", "/tmp/AuthKey_ABC.p8"],
    sourceDir: projectDir,
    logPrefix: "ios-simulator-build",
    header: ["Key  nbk1:0123456789abcdef"],
    title: "Building App",
    successMessage: "Built App",
    failureMessage: "Build failed",
  });

const readLog = async () => {
  const logDir = path.join(projectDir, ".hot-updater", "log");
  const [logFile] = await fs.readdir(logDir);
  return fs.readFile(path.join(logDir, String(logFile)), "utf8");
};

const runFailingBuild = async () => {
  const error = await runBuild().then(
    () => {
      throw new Error("Expected the build to fail.");
    },
    (reason: unknown) => reason,
  );
  return error as Error & { logPath: string | null; summary: string[] };
};

describe("a failed xcodebuild", () => {
  it("prints its error lines and the log's path, not its first lines", async () => {
    const error = await runFailingBuild();

    expect(error.name).toBe("BuildFailedError");
    expect(error.message).toBe("Build failed: xcodebuild exited with code 65.");
    expect(error.logPath).toMatch(
      /^\.hot-updater\/log\/\d{8}-ios-simulator-build\.log$/,
    );
    expect(error.summary).toEqual([
      ERROR_LINE,
      "** BUILD FAILED **",
      "The following build commands failed:",
      "\tSwiftCompile normal arm64 /src/App/AppDelegate.swift (in target 'App' from project 'App')",
      "(1 failure)",
    ]);
    expect(stderr).toContain(ERROR_LINE);
    expect(stderr).toContain(`Build log: ${error.logPath}`);
    expect(stderr).not.toContain("Target dependency graph");
    expect(stderr).not.toContain("warning:");
    // A --json command's stdout stays its JSON.
    expect(stdout).not.toContain("missingSymbol");
    expect(stdout).not.toContain("Build log:");
    // The step's line says which step failed, with its duration.
    expect(stdout).toMatch(
      /Build failed · xcodebuild exited with code 65 +\d+\.\ds/,
    );
  });

  it("keeps xcodebuild's raw output in the log, through its last line", async () => {
    await runFailingBuild();

    const log = await readLog();
    expect(log).toContain(ERROR_LINE);
    expect(log).toContain("note: Target dependency graph (2 targets)");
    // Through xcodebuild's last line, then the failure.
    expect(log).toMatch(/last line of xcodebuild\n[^]*exit code 65/);
  });
});

it("prints the last lines of a failure without an error line", async () => {
  await writeExecutable(
    "xcodebuild",
    `#!/bin/sh
i=0
while [ $i -lt 100 ]; do echo "line $i"; i=$((i + 1)); done
exit 70
`,
  );

  const error = await runFailingBuild();

  expect(error.message).toBe("Build failed: xcodebuild exited with code 70.");
  expect(error.summary).toEqual(
    Array.from({ length: 15 }, (_, i) => `line ${i + 85}`),
  );
  expect(stderr).toContain("line 99");
  expect(stderr).not.toContain("line 84\n");
});

it("writes the command to the log, and one line with its duration to the terminal", async () => {
  await writeExecutable(
    "xcodebuild",
    `#!/bin/sh
echo "CompileC /dd/A.o /src/A.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'React-Core' from project 'Pods')"
echo "Ld /dd/App.app/App normal (in target 'App' from project 'App')"
echo "** BUILD SUCCEEDED **"
`,
  );

  const { logFilePath } = await runBuild();

  expect(logFilePath).toMatch(/ios-simulator-build\.log$/);
  const log = await readLog();
  expect(log).toContain("Key  nbk1:0123456789abcdef");
  expect(log).toMatch(
    /\$ xcodebuild -scheme App -authenticationKeyPath[^]*AuthKey_ABC\.p8/,
  );
  expect(log).toContain("** BUILD SUCCEEDED **");
  // Not a TTY: no spinner, only the finished step.
  expect(stdout).toMatch(/Built App +\d+\.\ds\n/);
  expect(stdout).not.toContain("xcodebuild");
  expect(stdout).not.toContain("AuthKey");
  expect(stdout).not.toContain("Building App");
});

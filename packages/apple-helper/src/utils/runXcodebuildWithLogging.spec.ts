import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// xcbeautify drops "error:" as it formats, and drains after xcodebuild exits.
const FAKE_XCBEAUTIFY = `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *"error: "*) echo "[x] \${line#*error: }" ;;
    *) echo "> $line" ;;
  esac
done
sleep 0.3
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
  // No real xcbeautify, nor anything else from the machine's PATH.
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
  // isXcbeautifyAvailable caches what it found.
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env["PATH"] = originalPath;
  await fs.rm(projectDir, { recursive: true, force: true });
});

const runFailingBuild = async () => {
  const { runXcodebuildWithLogging } =
    await import("./runXcodebuildWithLogging");
  const error = await runXcodebuildWithLogging({
    args: ["-scheme", "App"],
    sourceDir: projectDir,
    logPrefix: "ios-simulator-build",
    successMessage: "Build completed successfully",
    failureMessage: "Build failed",
  }).then(
    () => {
      throw new Error("Expected the build to fail.");
    },
    (reason: unknown) => reason,
  );
  return error as Error & { logPath: string | null; summary: string[] };
};

describe.each([
  ["without xcbeautify", false],
  ["with xcbeautify on PATH", true],
])("a failed xcodebuild %s", (_, withXcbeautify) => {
  beforeEach(async () => {
    if (withXcbeautify) {
      await writeExecutable("xcbeautify", FAKE_XCBEAUTIFY);
    }
  });

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
  });

  it("keeps xcodebuild's raw output in the log, through its last line", async () => {
    await runFailingBuild();

    const logDir = path.join(projectDir, ".hot-updater", "log");
    const [logFile] = await fs.readdir(logDir);
    const log = await fs.readFile(path.join(logDir, String(logFile)), "utf8");
    expect(log).toContain(ERROR_LINE);
    expect(log).toContain("note: Target dependency graph (2 targets)");
    expect(log).not.toContain("[x] ");
    expect(log).not.toContain("> ");
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
    Array.from({ length: 40 }, (_, i) => `line ${i + 60}`),
  );
  expect(stderr).toContain("line 99");
  expect(stderr).not.toContain("line 59\n");
});

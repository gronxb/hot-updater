import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { BuildFailedError } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  // Before React Native 0.79, CocoaPods runs codegen: pod install runs alone.
  getReactNativeMetadatas: () => ({
    packagePath: "/missing/react-native",
    versionRaw: "0.74.0",
    version: { major: 0, minor: 74 },
  }),
}));

import { installPodsIfNeeded } from "./cocoapods";

const REASON =
  "[!] Failed to load 'React-Core-prebuilt' podspec: pathname contains null byte";
const CAUSE =
  "    Underlying error: the prebuilt React Native core couldn't be read from /Users/runner/Library/Caches/CocoaPods/Pods/External/React-Core-prebuilt/0.88.0";

// What `pod install` prints when it fails after downloading React Native's
// prebuilt pods: its steps and its `[!]` error on stdout, curl's progress
// meter, redrawn with \r, on stderr.
const FAKE_POD = `#!/bin/sh
echo "Analyzing dependencies"
echo "Downloading dependencies"
echo "Installing React-Core-prebuilt (0.88.0)"
for size in 96.7M 29.5M; do
  printf '  %% Total    %% Received %% Xferd  Average Speed   Time    Time     Time  Current\\n' >&2
  printf '                                 Dload  Upload   Total   Spent    Left  Speed\\n' >&2
  printf '\\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0' >&2
  printf "\\r 36 $size   36 35.5M    0     0  13.9M      0  0:00:06  0:00:02  0:00:04 13.9M" >&2
  printf "\\r100 $size  100 $size    0     0  20.0M      0  0:00:04  0:00:04 --:--:-- 22.8M\\n" >&2
done
echo "Installing ReactNativeDependencies (0.88.0)"
echo ""
echo "${REASON}"
echo "${CAUSE}"
exit 1
`;

let projectDir: string;
let stderr: string;
const originalPath = process.env["PATH"];

beforeEach(async () => {
  // The log lands in the nearest package root's .hot-updater/log.
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pod-install-log-"));
  await fs.writeFile(path.join(projectDir, "package.json"), "{}");
  await fs.mkdir(path.join(projectDir, "ios"));
  await fs.writeFile(path.join(projectDir, "ios", "Podfile"), "");
  const binDir = path.join(projectDir, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "pod"), FAKE_POD, { mode: 0o755 });
  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  // Nothing else from the machine's PATH, such as a real pod.
  process.env["PATH"] = `${binDir}:/usr/bin:/bin`;
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env["PATH"] = originalPath;
  await fs.rm(projectDir, { recursive: true, force: true });
});

const failPodInstall = async () => {
  const error = await installPodsIfNeeded(path.join(projectDir, "ios")).then(
    () => {
      throw new Error("Expected pod install to fail.");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BuildFailedError);
  return error as BuildFailedError;
};

describe("a failed pod install", () => {
  it("prints CocoaPods' error from stdout, not curl's progress from stderr", async () => {
    const error = await failPodInstall();

    expect(error.message).toBe("pod install failed: exited with code 1");
    expect(error.summary).toEqual([
      "Installing React-Core-prebuilt (0.88.0)",
      "Installing ReactNativeDependencies (0.88.0)",
      `${REASON.slice(0, 75)}…`,
      `${CAUSE.slice(0, 75)}…`,
    ]);
    expect(error.summary.join("\n")).not.toMatch(/% Total|Dload|96\.7M/);
    for (const line of error.summary) {
      expect(line.length).toBeLessThanOrEqual(76);
    }

    const printed = stripVTControlCharacters(stderr);
    expect(printed).toContain("[!] Failed to load 'React-Core-prebuilt'");
    expect(printed).not.toContain("% Total");
    expect(error.logPath).toMatch(
      /^\.hot-updater\/log\/\d{8}-pod-install\.log$/,
    );
    expect(printed).toContain(`Build log: ${error.logPath}`);
  });

  it("keeps both streams whole in the log", async () => {
    const error = await failPodInstall();

    const log = await fs.readFile(
      path.join(projectDir, String(error.logPath)),
      "utf8",
    );
    expect(log).toContain("$ RCT_USE_RN_DEP=0 RCT_USE_PREBUILT_RNCORE=0");
    expect(log).toContain("100 96.7M  100 96.7M");
    expect(log).toContain(REASON);
    expect(log).toContain(CAUSE);
  });
});

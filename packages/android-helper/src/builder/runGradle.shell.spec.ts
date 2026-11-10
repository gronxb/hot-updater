import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", () => ({
  BuildFailedError: class extends Error {},
  getCwd: () => process.cwd(),
  p: { log: { info: vi.fn(), error: vi.fn() } },
}));
vi.mock("../utils/createGradleLogger", () => ({
  createGradleLogger: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    writeError: vi.fn(),
    processStream: vi.fn(),
  }),
}));

import { runGradle } from "./runGradle";

const dash = (() => {
  try {
    return execFileSync("which", ["dash"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The wrapper's shell on Debian and Ubuntu, wherever this runs: run as a
// program, it drops a variable whose name isn't a shell name.
it.skipIf(!dash)(
  "keeps the signing environment through a wrapper whose shell is dash",
  async () => {
    const android = fs.mkdtempSync(path.join(os.tmpdir(), "run-gradle-"));
    directories.push(android);
    const seen = path.join(android, "seen.env");
    fs.writeFileSync(
      path.join(android, "gradlew"),
      `#!${dash}\nenv > "${seen}"\n`,
      { mode: 0o755 },
    );
    const outputs = path.join(android, "app/build/outputs/apk/release");
    fs.mkdirSync(outputs, { recursive: true });
    fs.writeFileSync(path.join(outputs, "app-release.apk"), "");

    await runGradle({
      tasks: ["assembleRelease"],
      logPrefix: "android-release-build",
      appModuleName: "app",
      args: {},
      env: {
        "ORG_GRADLE_PROJECT_android.injected.signing.store.password": "secret",
      },
      androidProjectPath: android,
    });

    expect(fs.readFileSync(seen, "utf8")).toContain(
      "ORG_GRADLE_PROJECT_android.injected.signing.store.password=secret",
    );
  },
);

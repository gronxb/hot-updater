import fs from "fs";
import path from "path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  ExecaError: class extends Error {},
  execa: vi.fn(() => Object.assign(Promise.resolve({}), { all: undefined })),
}));
vi.mock("@hot-updater/cli-tools", () => ({
  BuildFailedError: class extends Error {},
  getCwd: () => "/app",
  p: { log: { info: vi.fn(), error: vi.fn() } },
}));
const logger = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../utils/createGradleLogger", () => ({
  createGradleLogger: () => ({
    start: logger.start,
    stop: vi.fn(),
    close: vi.fn(),
    writeError: vi.fn(),
    processStream: vi.fn(),
  }),
}));

import { formatCommand } from "../utils/formatCommand";
import { runGradle } from "./runGradle";

it("passes its environment to Gradle without printing it", async () => {
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  const env = {
    "ORG_GRADLE_PROJECT_android.injected.signing.store.password": "secret",
  };

  await expect(
    runGradle({
      tasks: ["assembleRelease"],
      logPrefix: "android-release-build",
      appModuleName: "app",
      args: { extraParams: ["-PMIN_BUNDLE_ID=id"] },
      env,
      androidProjectPath: "/app/android",
    }),
  ).resolves.toEqual({
    buildDirectory: "/app/android/app/build/outputs/apk/release",
    buildArtifactPath:
      "/app/android/app/build/outputs/apk/release/app-release.apk",
  });

  expect(execa).toHaveBeenCalledWith(
    "bash",
    ["./gradlew", "app:assembleRelease", "-x", "lint", "-PMIN_BUNDLE_ID=id"],
    expect.objectContaining({ cwd: "/app/android", env }),
  );
});

it("runs the wrapper itself when its environment needs no bash", async () => {
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.mocked(execa).mockClear();

  await runGradle({
    tasks: ["assembleRelease"],
    logPrefix: "android-release-build",
    appModuleName: "app",
    args: {},
    env: { JAVA_HOME: "/jdk" },
    androidProjectPath: "/app/android",
  });

  expect(execa).toHaveBeenCalledWith(
    "./gradlew",
    ["app:assembleRelease", "-x", "lint"],
    expect.objectContaining({ env: { JAVA_HOME: "/jdk" } }),
  );
});

describe("on Windows", () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  // NoDefaultCurrentDirectoryInExePath stops cmd.exe from finding a bare
  // gradlew.bat in the current directory.
  it("runs the project's gradlew.bat by its path", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(execa).mockClear();

    await runGradle({
      tasks: ["assembleRelease"],
      logPrefix: "android-release-build",
      appModuleName: "app",
      args: {},
      androidProjectPath: "/app/android",
    });

    expect(execa).toHaveBeenCalledWith(
      path.join("/app/android", "gradlew.bat"),
      expect.arrayContaining(["app:assembleRelease"]),
      expect.objectContaining({ cwd: "/app/android" }),
    );
  });

  // ninja 1.10.2, in the SDK's CMake 3.22.1, can't reach an object path over
  // 260 characters; at 259 CMake hashes the long part of its name. At 250,
  // the Windows QA's longest object dir (179) plus the hash and a 40-character
  // file name came to 252, which CMake can't shorten.
  it("has CMake keep object paths within MAX_PATH, unless a module sets its own limit", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    let script = "";
    vi.mocked(execa).mockImplementationOnce(((
      _command: string,
      args: string[],
    ) => {
      const index = args.indexOf("--init-script");
      if (index !== -1) script = fs.readFileSync(args[index + 1]!, "utf8");
      return Object.assign(Promise.resolve({}), { all: undefined });
    }) as never);

    await runGradle({
      tasks: ["assembleRelease"],
      logPrefix: "android-release-build",
      appModuleName: "app",
      args: {},
      androidProjectPath: "/app/android",
    });

    // Added once the module's build script ran, and only to a module whose
    // own CMake arguments don't set it: in examples/v0.88.0 with real
    // Gradle, a defaultConfig's 180 and a release build type's 190 each
    // configured CMake alone, and a module without one got 259.
    const add =
      "android.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_OBJECT_PATH_MAX=259')";
    expect(script).toContain("finalizeDsl { android ->");
    expect(script).toContain(
      "def configs = [android.defaultConfig] + android.buildTypes.toList() + android.productFlavors.toList()",
    );
    expect(script).toContain(
      "config.externalNativeBuild.cmake.arguments.any { it.startsWith('-DCMAKE_OBJECT_PATH_MAX') }",
    );
    expect(script).toMatch(
      new RegExp(
        `if \\(!own\\) \\{\\s+${add.replace(/[.()[\]']/g, "\\$&")}\\s+\\}`,
      ),
    );
    // Expo's root project plugin gives every module its own value from the
    // expo.android.cmakeObjectPathMax property, 1024 by default, which the
    // guard above then keeps: the script sets the property, as a string as
    // Expo reads it, unless the project, the user or the command line did.
    expect(script).toMatch(
      /gradle\.rootProject \{ root ->\s+if \(!root\.hasProperty\('expo\.android\.cmakeObjectPathMax'\)\) \{\s+root\.ext\.set\('expo\.android\.cmakeObjectPathMax', '259'\)\s+\}/,
    );
  });

  it("logs the command it runs, with the init script", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    logger.start.mockClear();
    let ran: string[] = [];
    vi.mocked(execa).mockImplementationOnce(((
      _command: string,
      args: string[],
    ) => {
      ran = args;
      return Object.assign(Promise.resolve({}), { all: undefined });
    }) as never);

    await runGradle({
      tasks: ["assembleRelease"],
      logPrefix: "android-release-build",
      appModuleName: "app",
      args: {},
      androidProjectPath: "/app/android",
    });

    const header: string[] = logger.start.mock.calls[0]![0].header;
    const command = header.find((line) => line.startsWith("$ "));
    expect(ran).toContain("--init-script");
    expect(command).toBe(
      `$ ${formatCommand(["gradlew.bat", "app:assembleRelease", "-x", "lint", "--init-script", ran[ran.indexOf("--init-script") + 1]!])}`,
    );
  });
});

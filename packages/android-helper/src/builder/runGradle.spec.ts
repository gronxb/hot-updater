import fs from "fs";

import { execa } from "execa";
import { expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  ExecaError: class extends Error {},
  execa: vi.fn(() => Object.assign(Promise.resolve({}), { all: undefined })),
}));
vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: () => "/app",
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
    "./gradlew",
    ["app:assembleRelease", "-x", "lint", "-PMIN_BUNDLE_ID=id"],
    expect.objectContaining({ cwd: "/app/android", env }),
  );
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let reactNativeVersion: { major: number; minor: number };

vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: () => root,
  getReactNativeMetadatas: () => ({
    packagePath: path.join(root, "node_modules", "react-native"),
    versionRaw: `${reactNativeVersion.major}.${reactNativeVersion.minor}.0`,
    version: reactNativeVersion,
  }),
  p: {
    log: { info: vi.fn() },
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock("execa", () => ({ execa: vi.fn(async () => ({})) }));

import { execa } from "execa";

import { installPodsIfNeeded, resolvePodInstallPlan } from "./cocoapods";

describe("resolvePodInstallPlan", () => {
  it("runs codegen itself where the deprecation flag skips CocoaPods codegen", () => {
    expect(
      resolvePodInstallPlan({ version: { major: 0, minor: 79 }, env: {} }),
    ).toEqual({
      runCodegen: true,
      env: {
        RCT_IGNORE_PODS_DEPRECATION: "1",
        RCT_USE_RN_DEP: "0",
        RCT_USE_PREBUILT_RNCORE: "0",
      },
    });
    expect(
      resolvePodInstallPlan({ version: { major: 0, minor: 88 }, env: {} }),
    ).toEqual({
      runCodegen: true,
      env: {
        RCT_IGNORE_PODS_DEPRECATION: "1",
        RCT_USE_RN_DEP: "1",
        RCT_USE_PREBUILT_RNCORE: "1",
      },
    });
  });

  it("leaves codegen to CocoaPods before React Native 0.79", () => {
    expect(
      resolvePodInstallPlan({ version: { major: 0, minor: 78 }, env: {} }),
    ).toEqual({
      runCodegen: false,
      env: { RCT_USE_RN_DEP: "0", RCT_USE_PREBUILT_RNCORE: "0" },
    });
  });

  it("leaves codegen to CocoaPods when the React Native version is unknown", () => {
    expect(
      resolvePodInstallPlan({ version: { major: 0, minor: 0 }, env: {} }),
    ).toEqual({
      runCodegen: false,
      env: { RCT_USE_RN_DEP: "0", RCT_USE_PREBUILT_RNCORE: "0" },
    });
  });

  it("keeps a user's deprecation flag and runs codegen only when it skips CocoaPods codegen", () => {
    expect(
      resolvePodInstallPlan({
        version: { major: 0, minor: 85 },
        env: { RCT_IGNORE_PODS_DEPRECATION: "0" },
      }),
    ).toMatchObject({
      runCodegen: false,
      env: { RCT_IGNORE_PODS_DEPRECATION: "0" },
    });
    expect(
      resolvePodInstallPlan({
        version: { major: 0, minor: 77 },
        env: { RCT_IGNORE_PODS_DEPRECATION: "1" },
      }),
    ).toMatchObject({
      runCodegen: false,
      env: { RCT_IGNORE_PODS_DEPRECATION: "1" },
    });
  });

  it("leaves codegen to the user who sets RCT_SKIP_CODEGEN", () => {
    expect(
      resolvePodInstallPlan({
        version: { major: 0, minor: 85 },
        env: { RCT_SKIP_CODEGEN: "1" },
      }).runCodegen,
    ).toBe(false);
  });

  it("keeps a user's prebuilt React Native flags", () => {
    expect(
      resolvePodInstallPlan({
        version: { major: 0, minor: 85 },
        env: { RCT_USE_RN_DEP: "0", RCT_USE_PREBUILT_RNCORE: "0" },
      }).env,
    ).toMatchObject({ RCT_USE_RN_DEP: "0", RCT_USE_PREBUILT_RNCORE: "0" });
  });
});

describe("installPodsIfNeeded", () => {
  let sourceDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-pods-"));
    sourceDir = path.join(root, "ios");
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, "Podfile"), "");
    vi.mocked(execa).mockClear();
    vi.stubEnv("RCT_IGNORE_PODS_DEPRECATION", undefined);
    vi.stubEnv("RCT_SKIP_CODEGEN", undefined);
    vi.stubEnv("RCT_USE_RN_DEP", undefined);
    vi.stubEnv("RCT_USE_PREBUILT_RNCORE", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("regenerates codegen output before pod install skips codegen", async () => {
    reactNativeVersion = { major: 0, minor: 85 };
    const stale = path.join(sourceDir, "build", "generated", "ios", "stale");
    await fs.mkdir(stale, { recursive: true });
    const derived = path.join(sourceDir, "build", "derived");
    await fs.mkdir(derived, { recursive: true });

    await installPodsIfNeeded(sourceDir);

    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "node",
        [
          path.join(
            root,
            "node_modules",
            "react-native",
            "scripts",
            "generate-codegen-artifacts.js",
          ),
          "-p",
          root,
          "-o",
          sourceDir,
          "-t",
          "ios",
        ],
        { cwd: root },
      ],
      [
        "pod",
        ["install"],
        {
          cwd: sourceDir,
          env: expect.objectContaining({ RCT_IGNORE_PODS_DEPRECATION: "1" }),
        },
      ],
    ]);
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(derived)).resolves.toBeTruthy();
  });

  it("leaves codegen to pod install before React Native 0.79", async () => {
    reactNativeVersion = { major: 0, minor: 74 };

    await installPodsIfNeeded(sourceDir);

    expect(vi.mocked(execa).mock.calls).toEqual([
      [
        "pod",
        ["install"],
        {
          cwd: sourceDir,
          env: { RCT_USE_RN_DEP: "0", RCT_USE_PREBUILT_RNCORE: "0" },
        },
      ],
    ]);
  });

  it("reports a failed codegen run instead of running pod install", async () => {
    reactNativeVersion = { major: 0, minor: 88 };
    vi.mocked(execa).mockRejectedValueOnce(new Error("codegen exploded"));

    await expect(installPodsIfNeeded(sourceDir)).rejects.toThrow(
      /React Native codegen failed\.\ncodegen exploded/,
    );
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });
});

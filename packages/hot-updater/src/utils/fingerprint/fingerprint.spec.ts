import fs from "fs";
import path from "path";
import { mockReactNativeProjectRoot } from "@hot-updater/plugin-core/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type FingerprintResult,
  isFingerprintEquals,
  nativeFingerprint,
} from ".";

describe("nativeFingerprint", () => {
  let rootDir: string;

  beforeEach(async () => {
    const mockedProject = await mockReactNativeProjectRoot({
      example: "rn-77",
    });
    rootDir = mockedProject.rootDir;
  }, 5000);

  const changePackageJsonVersion = () => {
    // change content
    const packageJsonFilePath = path.join(rootDir, "package.json");
    const packageJsonFileContent = JSON.parse(
      fs.readFileSync(packageJsonFilePath, { encoding: "utf-8" }),
    );
    packageJsonFileContent.version = `${packageJsonFileContent.version}-alpha01`;
    fs.writeFileSync(
      packageJsonFilePath,
      JSON.stringify(packageJsonFileContent),
    );
  };

  const changePackageJsonMiscellaneous = () => {
    // change content
    const packageJsonFilePath = path.join(rootDir, "package.json");
    const packageJsonFileContent = JSON.parse(
      fs.readFileSync(packageJsonFilePath, { encoding: "utf-8" }),
    );
    packageJsonFileContent.scripts.hello = "echo 'hello'";
    fs.writeFileSync(
      packageJsonFilePath,
      JSON.stringify(packageJsonFileContent),
    );
  };

  it("fingerprint changed if package.json modified", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: [],
    });

    // change content
    changePackageJsonVersion();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: [],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });

  it("fingerprint chnaged though package.json is ignored because of expo config hash", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: ["package.json"],
    });

    changePackageJsonVersion();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: ["package.json"],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });

  it("fingerprint not changed if package.json is ignored and miscellaneous changed", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: ["package.json"],
    });

    changePackageJsonMiscellaneous();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
      ignorePaths: ["package.json"],
    });

    expect(fingerprintBefore).toEqual(fingerprintAfter);
  });

  it("fingerprint changed if extraSources changed", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [".tmp"],
      ignorePaths: [],
    });

    fs.writeFileSync(path.resolve(rootDir, ".tmp"), "test", {
      encoding: "utf-8",
    });

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [".tmp"],
      ignorePaths: [],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });
});

describe("isFingerprintEquals", () => {
  const platformResult1: FingerprintResult = { hash: "1", sources: [] };
  const platformResult2: FingerprintResult = { hash: "2", sources: [] };
  const platformsResult1: {
    android: FingerprintResult;
    ios: FingerprintResult;
  } = { android: platformResult1, ios: platformResult2 };
  const platformsResult2: {
    android: FingerprintResult;
    ios: FingerprintResult;
  } = { android: platformResult2, ios: platformResult1 };
  it("return false if platform specific fingerprint result type is passed and another is type of the result of both platforms", () => {
    expect(
      // @ts-ignore
      isFingerprintEquals(platformResult1, platformsResult1),
    ).toBe(false);
  });

  it("return true if platform specific fingerprint hashes are the same", () => {
    expect(isFingerprintEquals(platformResult1, platformResult1)).toBe(true);
  });

  it("return false if platform specific fingerprint hashes are not the same", () => {
    expect(isFingerprintEquals(platformResult1, platformResult2)).toBe(false);
  });

  it("return true if platforms fingerprint hashes are the same", () => {
    expect(isFingerprintEquals(platformsResult1, platformsResult1)).toBe(true);
  });

  it("return false if platforms  fingerprint hashes are not the same", () => {
    expect(isFingerprintEquals(platformsResult1, platformsResult2)).toBe(false);
  });
});

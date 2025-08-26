import fs from "fs";
import path from "path";
import { mockReactNativeProjectRoot } from "@hot-updater/plugin-core/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { nativeFingerprint } from ".";
import { type FingerprintResult, isFingerprintEquals } from "./common";

describe("nativeFingerprint", () => {
  let rootDir: string;

  beforeEach(async () => {
    const mockedProject = await mockReactNativeProjectRoot({
      example: "rn-77",
    });
    rootDir = mockedProject.rootDir;

    // Create MainActivity.kt file for testing
    const mainActivityPath = path.join(
      rootDir,
      "android",
      "app",
      "src",
      "main",
      "java",
      "com",
      "hotupdaterexample",
    );
    await fs.promises.mkdir(mainActivityPath, { recursive: true });

    const mainActivityContent = `package com.hotupdaterexample

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "HotUpdaterExample"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(
      this,
      mainComponentName,
      DefaultNewArchitectureEntryPoint.getFabricEnabled()
    )
}`;

    fs.writeFileSync(
      path.join(mainActivityPath, "MainActivity.kt"),
      mainActivityContent,
      { encoding: "utf-8" },
    );
  }, 5000);

  const changeTestKtFile = () => {
    // change content
    const testKtFilePath = path.join(
      rootDir,
      "android",
      "app",
      "src",
      "main",
      "java",
      "com",
      "hotupdaterexample",
      "MainActivity.kt",
    );
    const testKtFileContent = fs.readFileSync(testKtFilePath, {
      encoding: "utf-8",
    });
    const modifiedContent = testKtFileContent.replace(
      "class MainActivity",
      "class MainActivityModified",
    );
    fs.writeFileSync(testKtFilePath, modifiedContent);
  };

  const changeTestKtFileMiscellaneous = () => {
    // change content
    const testKtFilePath = path.join(
      rootDir,
      "android",
      "app",
      "src",
      "main",
      "java",
      "com",
      "hotupdaterexample",
      "MainActivity.kt",
    );
    const testKtFileContent = fs.readFileSync(testKtFilePath, {
      encoding: "utf-8",
    });
    const modifiedContent = `${testKtFileContent}\n// Added comment`;
    fs.writeFileSync(testKtFilePath, modifiedContent);
  };

  it("fingerprint changed if MainActivity.kt modified", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    // change content
    changeTestKtFile();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });

  it("fingerprint not changed if MainActivity.kt is not modified", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    // Don't change content, just read the file
    const testKtFilePath = path.join(
      rootDir,
      "android",
      "app",
      "src",
      "main",
      "java",
      "com",
      "hotupdaterexample",
      "MainActivity.kt",
    );
    fs.readFileSync(testKtFilePath, { encoding: "utf-8" });

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    expect(fingerprintBefore).toEqual(fingerprintAfter);
  });

  it("fingerprint changed if MainActivity.kt has significant changes", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    changeTestKtFile();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });

  it("fingerprint changed if MainActivity.kt has minor changes", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    changeTestKtFileMiscellaneous();

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "android",
      extraSources: [],
    });

    expect(fingerprintBefore).not.toEqual(fingerprintAfter);
  });

  it("fingerprint changed if extraSources changed", async () => {
    const fingerprintBefore = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [],
    });

    fs.writeFileSync(path.resolve(rootDir, ".tmp"), "test", {
      encoding: "utf-8",
    });

    const fingerprintAfter = await nativeFingerprint(rootDir, {
      platform: "ios",
      extraSources: [".tmp"],
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

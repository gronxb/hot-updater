import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const androidAppDir = path.join(repoDir, "examples/v0.85.0/android/app");
const androidRootBuildGradlePath = path.join(
  repoDir,
  "examples/v0.85.0/android/build.gradle",
);
const buildGradlePath = path.join(androidAppDir, "build.gradle");
const mainManifestPath = path.join(
  androidAppDir,
  "src/main/AndroidManifest.xml",
);
const detoxTestPath = path.join(
  androidAppDir,
  "src/androidTest/java/com/hotupdaterexample/DetoxTest.java",
);
const androidTestManifestPath = path.join(
  androidAppDir,
  "src/androidTest/AndroidManifest.xml",
);
const proguardRulesPath = path.join(androidAppDir, "proguard-rules.pro");

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

describe("Detox Android native setup", () => {
  it("declares the Detox Android instrumentation runner and dependency", async () => {
    // Given: the release Android app must build a Detox test APK.
    const androidRootBuildGradle = await readText(androidRootBuildGradlePath);
    const buildGradle = await readText(buildGradlePath);

    // When: Detox is configured for the example app.
    const requiredGradleMarkers = [
      'url("$rootDir/../../../node_modules/detox/Detox-android")',
      'testBuildType System.getProperty("testBuildType", "debug")',
      'testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',
      'androidTestImplementation("com.wix:detox:+")',
      'androidTestImplementation("androidx.test:core:1.6.1")',
      'androidTestImplementation("androidx.test:runner:1.6.2")',
      'androidTestImplementation("androidx.test:rules:1.6.1")',
    ];

    // Then: Gradle can assemble both the app and Android test APKs.
    for (const marker of requiredGradleMarkers) {
      expect(`${androidRootBuildGradle}\n${buildGradle}`).toContain(marker);
    }
  });

  it("keeps local control-server traffic available to Android tests", async () => {
    // Given: the E2E app must reach the local control server.
    const manifest = await readText(mainManifestPath);

    // When: Android launches through Detox.
    const cleartextMarkers = [
      'android:usesCleartextTraffic="true"',
      'android:networkSecurityConfig="@xml/network_security_config"',
    ];

    // Then: localhost and emulator host traffic are permitted explicitly.
    for (const marker of cleartextMarkers) {
      expect(manifest).toContain(marker);
    }
    await expect(
      readText(
        path.join(
          androidAppDir,
          "src/main/res/xml/network_security_config.xml",
        ),
      ),
    ).resolves.toContain("10.0.2.2");
  });

  it("includes the Detox Android test class and release keep rules", async () => {
    // Given: Detox requires a native instrumentation entrypoint.
    const detoxTest = await readText(detoxTestPath);
    const proguardRules = await readText(proguardRulesPath);

    // When: release builds are used for provider verification.
    const nativeMarkers = [
      "public class DetoxTest",
      "com.hotupdaterexample",
      "-keep class com.wix.detox.**",
    ];

    // Then: instrumentation and release minification remain compatible.
    for (const marker of nativeMarkers) {
      expect(`${detoxTest}\n${proguardRules}`).toContain(marker);
    }
  });

  it("pins AndroidX test activities required by release test APK merging", async () => {
    // Given: release Android test APKs merge AndroidX test-core activities.
    const androidTestManifest = await readText(androidTestManifestPath);

    // When: current Android SDK rules require exported attributes.
    const activityMarkers = [
      "androidx.test.core.app.InstrumentationActivityInvoker$BootstrapActivity",
      "androidx.test.core.app.InstrumentationActivityInvoker$EmptyActivity",
      "androidx.test.core.app.InstrumentationActivityInvoker$EmptyFloatingActivity",
      'android:exported="true"',
    ];

    // Then: the scoped androidTest manifest supplies the missing attributes.
    for (const marker of activityMarkers) {
      expect(androidTestManifest).toContain(marker);
    }
  });
});

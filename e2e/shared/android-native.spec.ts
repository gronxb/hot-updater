import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeBuildPlan } from "../mobile/build.ts";
const repoDir = path.resolve(import.meta.dirname, "../..");
const androidAppDir = path.join(repoDir, "examples/v0.85.0/android/app");

describe("Android E2E native setup", () => {
  it("builds a debuggable release APK with the fixed minimum Bundle ID and selected ABIs", () => {
    const [command] = createNativeBuildPlan(
      { platform: "android", dryRun: true },
      repoDir,
      {},
    );
    expect(command.args).toContain(":app:assembleRelease");
    expect(command.args).not.toContain(":app:assembleReleaseAndroidTest");
    expect(command.args).toContain("-PHOT_UPDATER_E2E_DEBUGGABLE=true");
    expect(command.args).toContain(
      "-PMIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000",
    );
    expect(command.args).toContain(
      "-PreactNativeArchitectures=arm64-v8a,x86_64",
    );
  });
  it("retains release file access while disabling React Native development support", async () => {
    const build = await fs.readFile(
      path.join(androidAppDir, "build.gradle"),
      "utf8",
    );
    const application = await fs.readFile(
      path.join(
        androidAppDir,
        "src/main/java/com/hotupdaterexample/MainApplication.kt",
      ),
      "utf8",
    );
    expect(build).toContain("debuggable hotUpdaterE2eDebuggable");
    expect(build).toContain(
      'buildConfigField "boolean", "HOT_UPDATER_E2E_DISABLE_DEV_SUPPORT", hotUpdaterE2eDebuggable.toString()',
    );
    expect(application).toContain("HOT_UPDATER_E2E_DISABLE_DEV_SUPPORT");
  });
  it("keeps local control-server traffic available", async () => {
    const manifest = await fs.readFile(
      path.join(androidAppDir, "src/main/AndroidManifest.xml"),
      "utf8",
    );
    expect(manifest).toContain('android:usesCleartextTraffic="true"');
    expect(manifest).toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
    const network = await fs.readFile(
      path.join(androidAppDir, "src/main/res/xml/network_security_config.xml"),
      "utf8",
    );
    expect(network).toContain("10.0.2.2");
  });
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("Lynx E2E suite manifest", () => {
  it("dry-run plans the default Detox suite names", () => {
    const expected = JSON.parse(
      readFileSync(
        path.join(repoDir, "e2e/detox/default-scenario-names.json"),
        "utf8",
      ),
    ) as string[];
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(repoDir, "e2e/lynx/scripts/run.ts"),
        "--dry-run",
        "--platform",
        "ios",
      ],
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const planned = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+/.test(line))
      .map((line) => line.replace(/^\d+\.\s+/, ""));
    expect(planned).toEqual(expected);
  });

  it("bootstraps CocoaPods before the iOS e2e native build", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/scripts/build-e2e-native.mjs"),
      "utf8",
    );
    const bootstrap = readFileSync(
      path.join(repoDir, "examples/lynx/ios/bootstrap.sh"),
      "utf8",
    );
    const gemfile = readFileSync(
      path.join(repoDir, "examples/lynx/ios/Gemfile"),
      "utf8",
    );
    expect(source).toContain('run("sh", ["bootstrap.sh"], iosDir)');
    expect(source).toContain('mkdirSync(path.join(iosDir, "Embedded")');
    expect(source).toContain("-PlynxE2eDebuggable=true");
    expect(source).toContain("-derivedDataPath");
    expect(source).toContain("build");
    expect(gemfile).toContain('gem "cocoapods-lynx-library", "3.9.0"');
    expect(bootstrap).toContain("bundle install");
    expect(bootstrap).toContain("bundle exec pod install");
  });

  it("declares bundle signing so agent setup can export the public key", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/hot-updater.config.ts"),
      "utf8",
    );
    expect(source).toContain('privateKeyPath: "./keys/private-key.pem"');
    expect(source).toMatch(/signing:\s*\{[\s\S]*enabled:\s*true/);
    expect(source).toContain("getBundleSigningPublicKey");
    expect(source).toContain("keys/public-key.pem");
    expect(source).toContain("copyE2eFixtures");
    expect(source).toContain("assets/src/test");
    expect(source).toContain("src_test_");
  });

  it("passes the exported native public key into Lynx hosts", () => {
    const iosHost = readFileSync(
      path.join(
        repoDir,
        "examples/lynx/ios/SparklingGo/SparklingGo/PublicHost.swift",
      ),
      "utf8",
    );
    const androidHost = readFileSync(
      path.join(
        repoDir,
        "examples/lynx/android/app/src/main/java/com/hotupdater/lynxexample/OtaActivity.kt",
      ),
      "utf8",
    );
    expect(iosHost).toContain("HOT_UPDATER_PUBLIC_KEY");
    expect(iosHost).toContain("publicKeyPEM:");
    expect(androidHost).toContain("com.hotupdater.PUBLIC_KEY");
    expect(androidHost).toContain("publicKeyPem");
  });

  it("uses agent device env vars instead of simctl booted", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/lynx-app-driver.ts"),
      "utf8",
    );
    expect(source).toContain("HOT_UPDATER_E2E_IOS_SIMULATOR_NAME");
    expect(source).toContain("HOT_UPDATER_E2E_ANDROID_SERIAL");
  });

  it("installs the Lynx app before resetting local device state", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/scripts/run.ts"),
      "utf8",
    );
    const installAt = source.indexOf("app.ensureInstalled()");
    const resetAt = source.indexOf('"/e2e/reset-local-app-state"');
    expect(installAt).toBeGreaterThan(0);
    expect(resetAt).toBeGreaterThan(installAt);
  });
});

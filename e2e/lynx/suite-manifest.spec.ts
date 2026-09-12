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
    expect(androidHost).toContain("resolveEmbeddedDir");
    expect(androidHost).toContain("filesDir");
    expect(androidHost).toContain("overlay-js-load-started");
    const manifest = readFileSync(
      path.join(
        repoDir,
        "examples/lynx/android/app/src/main/AndroidManifest.xml",
      ),
      "utf8",
    );
    expect(manifest).toContain('android:usesCleartextTraffic="true"');
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
    const overlayAt = source.indexOf("app.prepareOverlay()");
    const resetAt = source.indexOf('"/e2e/reset-local-app-state"');
    expect(installAt).toBeGreaterThan(0);
    expect(overlayAt).toBeGreaterThan(installAt);
    expect(resetAt).toBeGreaterThan(overlayAt);
  });

  it("reuses one overlay compile across launch and reload", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/lynx-app-driver.ts"),
      "utf8",
    );
    expect(source).toContain("overlayDirPromise");
    expect(source).toContain("prepareOverlay()");
    expect(source).toContain("await this.prepareOverlay()");
  });

  it("installs the Lynx app only during ensureInstalled", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/lynx-app-driver.ts"),
      "utf8",
    );
    const launchAt = source.indexOf("private async launchApp(");
    const terminateAt = source.indexOf("private terminateApp()");
    expect(launchAt).toBeGreaterThan(0);
    expect(terminateAt).toBeGreaterThan(launchAt);
    expect(source.slice(launchAt, terminateAt)).not.toContain(
      "this.installApp()",
    );
    expect(source).toContain(
      "ensureInstalled(): void {\n    this.installApp();",
    );
  });

  it("keeps Lynx overlay running if Metro asset requires throw", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/patchSurface.ts"),
      "utf8",
    );
    expect(source).toContain("loadE2EDeployBundleAssets");
    expect(source).toContain("try {");
    expect(source).toContain("E2E_DEPLOY_ASSET_GUARD_START");
    expect(source).toContain("hot-updater e2e crash bundle");
    expect(source).toContain("NATIVE_STATE");
  });

  it("starts the pending-action poller after handlers bind", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    expect(source).toContain("ensurePendingActionPoller");
    expect(source).toContain("pollPendingActionOnce");
    expect(source).toContain(
      "Object.keys(actionHandlers.current).length === 0",
    );
    expect(source).toContain("actionHandlers.current = actions;");
    expect(source).toContain(
      "void patchScreenState({ runtimeScenarioMarker: scenarioMarker });",
    );
    const bindAt = source.indexOf("actionHandlers.current = actions;");
    const pollerAt = source.indexOf("ensurePendingActionPoller();");
    const crashAt = source.indexOf("maybeCrashForE2E();");
    const renderAt = source.indexOf("root.render(<App />);");
    expect(bindAt).toBeGreaterThan(0);
    expect(pollerAt).toBeGreaterThan(bindAt);
    expect(crashAt).toBeGreaterThan(0);
    expect(renderAt).toBeGreaterThan(crashAt);
  });

  it("treats Lynx startup JS errors as fatal native crashes", () => {
    const iosHost = readFileSync(
      path.join(
        repoDir,
        "examples/lynx/ios/SparklingGo/SparklingGo/PublicHost.swift",
      ),
      "utf8",
    );
    const androidController = readFileSync(
      path.join(
        repoDir,
        "packages/lynx/android/src/main/java/com/hotupdater/lynx/LynxUpdaterController.kt",
      ),
      "utf8",
    );
    const driver = readFileSync(
      path.join(repoDir, "e2e/lynx/lynx-app-driver.ts"),
      "utf8",
    );
    expect(iosHost).toContain("hot-updater e2e crash");
    expect(iosHost).toContain("exit(0)");
    expect(androidController).toContain("Process.killProcess");
    expect(driver).toContain("options.expectCrash === true");
    expect(driver).toContain("files/e2e-embedded");
    expect(driver).toContain('return "e2e-embedded"');
    expect(driver).toContain("assertAndroidOverlayLoaded");
    expect(driver).toContain("waitForOverlayReady");
    expect(driver).toContain("runtimeScenarioMarker");
    expect(driver).toContain('"tee"');
    expect(driver).toContain("overlay-js-load-started");
    expect(driver).toContain('"start",\n        "-S"');
    expect(driver).toContain("Date.now() + 60_000");
    const embed = readFileSync(
      path.join(repoDir, "e2e/lynx/embedded-bundle.ts"),
      "utf8",
    );
    expect(embed).toContain("Lynx overlay bundle is missing scenario marker");
    expect(embed).toContain("HOT_UPDATER_E2E_OVERLAY_MARKER");
    const overlayApp = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    expect(overlayApp).toContain("__E2E_OVERLAY_MARKER__");
    expect(overlayApp).toContain("scenarioMarker");
  });

  it("projects Lynx journals onto RN store assertions", () => {
    const controller = readFileSync(
      path.join(repoDir, "e2e/detox/control-server/controller.ts"),
      "utf8",
    );
    const overlay = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    expect(controller).toContain('from "./lynx-store.ts"');
    expect(controller).toContain("readLynxSynthesizedSnapshot");
    expect(controller).toContain("HotUpdaterLynxPublic");
    expect(controller).toContain("hot-updater-lynx/scopes");
    expect(controller).toContain("main.lynx.bundle");
    expect(controller).toContain("lynx zip install used instead of bsdiff");
    expect(overlay).toContain("runtimeScenarioMarker");
    expect(overlay).toContain("publishRuntimeSnapshot");
  });
});

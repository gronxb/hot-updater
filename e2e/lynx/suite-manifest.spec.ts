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
    expect(source).toContain("fingerprint:");
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
    expect(iosHost).toContain("HOT_UPDATER_FINGERPRINT_HASH");
    expect(iosHost).toContain("fingerprintHash:");
    expect(iosHost).toContain("publicKeyPEM:");
    expect(androidHost).toContain("com.hotupdater.PUBLIC_KEY");
    expect(androidHost).toContain("com.hotupdater.FINGERPRINT_HASH");
    expect(androidHost).toContain("fingerprintHash");
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
    expect(manifest).toContain("com.hotupdater.FINGERPRINT_HASH");
    const fingerprintJson = readFileSync(
      path.join(repoDir, "examples/lynx/fingerprint.json"),
      "utf8",
    );
    expect(fingerprintJson).toContain('"ios"');
    expect(fingerprintJson).toContain('"android"');
    expect(fingerprintJson).not.toContain("package:react-native");
    expect(fingerprintJson).not.toContain("expoAutolinkingConfig");
    const iosPlist = readFileSync(
      path.join(repoDir, "examples/lynx/ios/Info.plist"),
      "utf8",
    );
    expect(iosPlist).toContain("HOT_UPDATER_FINGERPRINT_HASH");
  });

  it("uses agent device env vars instead of simctl booted", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/lynx-app-driver.ts"),
      "utf8",
    );
    expect(source).toContain("HOT_UPDATER_E2E_IOS_SIMULATOR_NAME");
    expect(source).toContain("HOT_UPDATER_E2E_ANDROID_SERIAL");
    expect(source).toContain("lynx-overlay-dir");
    const controller = readFileSync(
      path.join(repoDir, "e2e/detox/control-server/controller.ts"),
      "utf8",
    );
    expect(controller).toContain(".OtaActivity");
    expect(controller).toContain("--ota-channel=production");
  });

  it("installs the Lynx app before resetting local device state", () => {
    const source = readFileSync(
      path.join(repoDir, "e2e/lynx/scripts/run.ts"),
      "utf8",
    );
    const installAt = source.indexOf("app.ensureInstalled()");
    const overlayAt = source.indexOf("app.prepareOverlay()");
    const resetAt = source.indexOf('"/e2e/reset-local-app-state"');
    const uninstallAt = source.indexOf("app.uninstallApp()");
    const reinstallAt = source.lastIndexOf("app.ensureInstalled()");
    expect(installAt).toBeGreaterThan(0);
    expect(overlayAt).toBeGreaterThan(installAt);
    expect(resetAt).toBeGreaterThan(overlayAt);
    expect(uninstallAt).toBeGreaterThan(resetAt);
    expect(reinstallAt).toBeGreaterThan(uninstallAt);
  });

  it("resets patched app source on every bootstrap after the first", () => {
    const controller = readFileSync(
      path.join(repoDir, "e2e/detox/control-server/controller.ts"),
      "utf8",
    );
    expect(controller).toContain("async function resetBootstrappedAppSource()");
    const startBootstrap = controller.slice(
      controller.indexOf("export function startBootstrapJob()"),
      controller.indexOf("export function startDeployBundleJob"),
    );
    expect(startBootstrap).toContain('job?.status === "running"');
    expect(startBootstrap).not.toContain("succeeded");
    const bootstrapFn = controller.slice(
      controller.indexOf("async function bootstrap()"),
      controller.indexOf("async function captureBuiltInBundleId"),
    );
    expect(bootstrapFn).toContain("await resetBootstrappedAppSource()");
    expect(bootstrapFn).toContain('mode: "reset"');
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
    expect(source).toContain("INPUT_TEXT_FIELDS");
    expect(source).toContain('"cohort-input": "cohortInput"');
    expect(source).toContain("wait ${field}");
    expect(source).toContain("uninstallApp(): void {");
    expect(source).toContain('["simctl", "uninstall", this.deviceId()');
    expect(source).toContain('"uninstall", this.appId()');
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
    expect(source).toContain("void resolveAppBaseURL()");
    expect(source).toContain("startE2eApp(baseURL)");
    const bindAt = source.indexOf("actionHandlers.current = actions;");
    const pollerAt = source.indexOf("ensurePendingActionPoller();");
    const crashAt = source.indexOf("maybeCrashForE2E();");
    const renderAt = source.indexOf("root.render(<App />);");
    const resolveAt = source.indexOf("void resolveAppBaseURL()");
    const startAt = source.lastIndexOf("startE2eApp(baseURL)");
    expect(bindAt).toBeGreaterThan(0);
    expect(pollerAt).toBeGreaterThan(bindAt);
    expect(crashAt).toBeGreaterThan(0);
    expect(renderAt).toBeGreaterThan(crashAt);
    expect(resolveAt).toBeGreaterThan(renderAt);
    expect(startAt).toBeGreaterThan(resolveAt);
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
    expect(iosHost).toContain("lynxErrorText");
    expect(iosHost).toContain("summaryMessage");
    const iosModule = readFileSync(
      path.join(
        repoDir,
        "packages/lynx/ios/Sources/HotUpdaterLynxArtifact/HotUpdaterLynxModule.swift",
      ),
      "utf8",
    );
    expect(iosModule).toContain("rawArtifact == nil || rawArtifact is NSNull");
    const iosController = readFileSync(
      path.join(
        repoDir,
        "packages/lynx/ios/Sources/HotUpdaterLynxArtifact/LynxController.swift",
      ),
      "utf8",
    );
    expect(iosController).toContain("let snapshotChannel = runtimeChannel");
    expect(iosController).toContain("let snapshotCohort = runtimeCohort");
    expect(iosController).toContain("channel: snapshotChannel");
    expect(iosController).toContain("cohort: snapshotCohort");
    expect(iosController).toContain(
      "fingerprintHash: configuration.fingerprintHash",
    );
    expect(androidController).toContain(
      "configuration.fingerprintHash ?: binaryId",
    );
    expect(androidController).toContain(
      "CatalogPolicy.selectionContextHash(after, checked.guard.scopeKey)",
    );
    expect(androidController).toContain(
      "CatalogPolicy.selectionContextHash(startupSnapshot, storedScope)",
    );
    expect(androidController).toContain("runCatching {");
    expect(androidController).toContain("}.getOrNull()");
    const iosCatalogPolicy = readFileSync(
      path.join(
        repoDir,
        "packages/lynx/ios/Sources/HotUpdaterLynxArtifact/CatalogPolicy.swift",
      ),
      "utf8",
    );
    expect(iosCatalogPolicy).toContain(
      "selectionContextHash: contextHash(snapshot: snapshot, scopeKey: catalog.scopeKey)",
    );
    const checkForUpdate = readFileSync(
      path.join(repoDir, "packages/lynx/src/checkForUpdate.ts"),
      "utf8",
    );
    expect(checkForUpdate).toContain(
      "guard.selectionContextHash ?? selectionContextHash",
    );
    expect(androidController).toContain(
      'it.put("channel", configuration.channel)',
    );
    expect(iosController).toContain(
      "recovered.selectionChannel = config.channel",
    );
    expect(iosModule).toContain("NSStringFromSelector(#selector(reload(_:)))");
    const androidModule = readFileSync(
      path.join(
        repoDir,
        "packages/lynx/android/src/main/java/com/hotupdater/lynx/HotUpdaterLynxModule.kt",
      ),
      "utf8",
    );
    expect(androidModule).toContain(
      "Started restart trampoline to apply update bundle",
    );
    expect(androidModule).toContain("@LynxMethod fun reload");
    const e2eApp = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    expect(e2eApp).toContain("shouldForceUpdate");
    expect(e2eApp).toContain("updateInfo.updateBundle()");
    expect(androidController).toContain("Process.killProcess");
    expect(driver).toContain("options.expectCrash === true");
    expect(driver).toContain("files/e2e-embedded");
    expect(driver).toContain('return "e2e-embedded"');
    expect(driver).toContain("assertAndroidOverlayLoaded");
    expect(driver).toContain("Date.now() + 20_000");
    expect(driver).toContain("waitForOverlayReady");
    expect(driver).toContain("options.allowDisconnect === true");
    expect(driver).toContain("runtimeScenarioMarker: null");
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
    expect(embed).toContain("Lynx overlay bundle contains the E2E crash guard");
    expect(embed).toContain("E2E_SAFE_BUNDLE_IDS");
    expect(embed).toContain("HOT_UPDATER_E2E_OVERLAY_MARKER");
    expect(embed).toContain("rewriteLynxAndroidEmulatorUrl");
    expect(embed).toContain("10.0.2.2");
    const lynxConfig = readFileSync(
      path.join(repoDir, "examples/lynx/hot-updater.config.ts"),
      "utf8",
    );
    expect(lynxConfig).toContain("rewriteAndroidEmulatorUrl");
    expect(lynxConfig).toContain("10.0.2.2");
    expect(lynxConfig).toContain('platform === "android"');
    const overlayApp = readFileSync(
      path.join(repoDir, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    expect(overlayApp).toContain("__E2E_OVERLAY_MARKER__");
    expect(overlayApp).toContain("__E2E_BUILD_ID__");
    expect(overlayApp).toContain("Current Launch Status: ERROR");
    expect(overlayApp).toContain("scenarioMarker");
    expect(overlayApp).toContain("HotUpdater.getDefaultChannel()");
    expect(overlayApp).toContain("HotUpdater.isChannelSwitched()");
    expect(driver).toContain("runtime-current-channel");
    expect(driver).toContain("currentChannel");
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
    expect(controller).toContain("lynxAndroidInstalledManifestPaths");
    expect(controller).toContain("main.lynx.bundle");
    const prepareBody = controller.slice(
      controller.indexOf("async function prepareAppLaunch()"),
      controller.indexOf("async function bootstrap()"),
    );
    expect(prepareBody).toContain("resetE2eScreenState();");
    expect(prepareBody).toContain("resetPendingE2eAction();");
    const lynxStore = readFileSync(
      path.join(repoDir, "e2e/detox/control-server/lynx-store.ts"),
      "utf8",
    );
    expect(lynxStore).toContain("payload/manifest.json");
    expect(controller).toContain("lynx zip install used instead of bsdiff");
    expect(overlay).toContain("runtimeScenarioMarker");
    expect(overlay).toContain("publishRuntimeSnapshot");
  });
});

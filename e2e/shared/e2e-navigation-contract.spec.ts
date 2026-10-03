import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const appPath = path.join(repoDir, "examples/v0.85.0/App.tsx");
const e2eAppIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/index.tsx",
);
const e2eAppShellPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/app-shell.tsx",
);
const e2eAppPatchSurfacePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/patchSurface.ts",
);
const e2eAppRoutePathsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/route-paths.ts",
);
const e2eAppRoutesPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes.tsx",
);
const e2eAppRouteStackPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/route-stack.ts",
);
const e2eAppNavigationControllerPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/navigation-controller.ts",
);
const e2eAppScreensIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/index.ts",
);
const e2eAppTopLevelScreensPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens.tsx",
);
const e2eAppScreensDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens",
);
const e2eAppComponentsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/components.tsx",
);
const androidManifestPath = path.join(
  repoDir,
  "examples/v0.85.0/android/app/src/main/AndroidManifest.xml",
);
const iosAppDelegatePath = path.join(
  repoDir,
  "examples/v0.85.0/ios/HotUpdaterExample/AppDelegate.swift",
);
const mobileDriverPath = path.join(repoDir, "e2e/mobile/driver.ts");
const sharedScreenRoutesDir = path.join(repoDir, "e2e/shared/screen-routes");
const examplePackagePath = path.join(repoDir, "examples/v0.85.0/package.json");
const iosInfoPlistPath = path.join(
  repoDir,
  "examples/v0.85.0/ios/HotUpdaterExample/Info.plist",
);

const readSharedScreenRoutesSource = async (): Promise<string> => {
  const fileNames = (await fs.readdir(sharedScreenRoutesDir)).filter(
    (fileName) => fileName.endsWith(".js"),
  );
  const sources = await Promise.all(
    fileNames.map((fileName) =>
      fs.readFile(path.join(sharedScreenRoutesDir, fileName), "utf8"),
    ),
  );
  return sources.join("\n");
};

describe("E2E navigation contract", () => {
  it("forgets the cached screen before a replacement app can disconnect", async () => {
    const mobileDriverSource = await fs.readFile(mobileDriverPath, "utf8");
    const launchBody = mobileDriverSource.slice(
      mobileDriverSource.indexOf("private async openApp"),
      mobileDriverSource.indexOf("private resolve"),
    );
    const resetIndex = launchBody.indexOf("activeScreenPath = undefined;");
    const launchIndex = launchBody.indexOf("await this.options.device.openApp");

    expect(resetIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeLessThan(launchIndex);
  });

  it("uses React Navigation screens instead of one scroll-heavy E2E surface", async () => {
    const appSource = await fs.readFile(appPath, "utf8");
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppShellSource = await fs.readFile(e2eAppShellPath, "utf8");
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppRouteStackSource = await fs.readFile(
      e2eAppRouteStackPath,
      "utf8",
    );
    const e2eAppRoutePathsSource = await fs.readFile(
      e2eAppRoutePathsPath,
      "utf8",
    );
    const e2eAppPatchSurfaceSource = await fs.readFile(
      e2eAppPatchSurfacePath,
      "utf8",
    );
    const e2eAppComponentsSource = await fs.readFile(
      e2eAppComponentsPath,
      "utf8",
    );
    const e2eAppScreenFiles = await fs.readdir(e2eAppScreensDir);
    const examplePackage = JSON.parse(
      await fs.readFile(examplePackagePath, "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const exampleDependencies = {
      ...examplePackage.dependencies,
      ...examplePackage.devDependencies,
    };

    expect(exampleDependencies["@react-navigation/native"]).toBeTypeOf(
      "string",
    );
    expect(exampleDependencies["@react-navigation/native-stack"]).toBeTypeOf(
      "string",
    );
    expect(exampleDependencies["react-native-screens"]).toBeTypeOf("string");
    expect(appSource).toContain("E2eHotUpdaterApp");
    expect(appSource).toContain("patchSurface");
    expect(e2eAppIndexSource).toBe(
      'export { E2eHotUpdaterApp } from "./app-shell";\n',
    );
    expect(e2eAppShellSource).toContain("NavigationContainer");
    expect(e2eAppShellSource).toContain("E2eStack");
    expect(e2eAppShellSource).toContain("e2eLinking");
    expect(e2eAppShellSource).toContain("navigationRef");
    expect(e2eAppShellSource).toContain("linking={e2eLinking}");
    expect(e2eAppIndexSource).not.toContain("createNativeStackNavigator");
    expect(e2eAppIndexSource).not.toContain("Stack.Screen");
    expect(e2eAppRouteStackSource).toContain("createNativeStackNavigator");
    expect(e2eAppRoutesSource).toContain('initialRouteName="Ready"');
    expect(e2eAppScreenFiles).toContain("ready-screen.tsx");
    expect(e2eAppScreenFiles).toContain("runtime-bundle-screen.tsx");
    expect(e2eAppScreenFiles).toContain("runtime-marker-screen.tsx");
    expect(e2eAppScreenFiles).toContain("runtime-large-asset-screen.tsx");
    expect(e2eAppScreenFiles).toContain("launch-status-screen.tsx");
    expect(e2eAppScreenFiles).toContain("launch-transition-screen.tsx");
    expect(e2eAppScreenFiles).toContain("runtime-release-state-screen.tsx");
    expect(e2eAppScreenFiles).toContain(
      "install-current-channel-update-action-screen.tsx",
    );
    expect(e2eAppScreenFiles).toContain("runtime-channel-input-screen.tsx");
    expect(e2eAppScreenFiles).toContain("cohort-input-screen.tsx");
    expect(e2eAppScreenFiles).toContain("set-cohort-qa-action-screen.tsx");
    expect(e2eAppScreenFiles).toContain("channel-action-result-screen.tsx");
    expect(e2eAppScreenFiles).toContain("update-action-result-screen.tsx");
    expect(e2eAppScreenFiles).toContain("cohort-action-result-screen.tsx");
    expect(e2eAppComponentsSource).not.toContain("ScrollView");
    expect(e2eAppComponentsSource).not.toContain("ScreenTabs");
    expect(e2eAppComponentsSource).not.toContain("e2e-nav-");
    expect(e2eAppComponentsSource).not.toContain("screenContentTestIDs");
    expect(e2eAppComponentsSource).not.toContain("current: ScreenName");
    expect(e2eAppRoutePathsSource).toContain("hotupdaterexample://");
    await expect(fs.stat(e2eAppTopLevelScreensPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(e2eAppScreensIndexPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(e2eAppPatchSurfaceSource).toContain("E2E_SCENARIO_MARKER");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_CRASH_GUARD_START");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_DEPLOY_ASSET_GUARD_START");
    expect(appSource).not.toContain("sectionOffsets");
    expect(appSource).not.toContain("scrollToSection");
  });

  it("handles E2E deep links through an explicit navigation ref", async () => {
    const e2eAppShellSource = await fs.readFile(e2eAppShellPath, "utf8");
    const e2eAppRoutePathsSource = await fs.readFile(
      e2eAppRoutePathsPath,
      "utf8",
    );
    const e2eAppNavigationControllerSource = await fs.readFile(
      e2eAppNavigationControllerPath,
      "utf8",
    );

    expect(e2eAppShellSource).toContain("navigationRef");
    expect(e2eAppShellSource).toContain("linking={e2eLinking}");
    expect(e2eAppShellSource).toContain("useE2eDeepLinks");
    expect(e2eAppShellSource).toContain("flushPendingE2eDeepLink");
    expect(e2eAppShellSource).toContain("ref={navigationRef}");
    expect(e2eAppShellSource).toContain("onReady={flushPendingE2eDeepLink}");
    expect(e2eAppNavigationControllerSource).toContain(
      "createNavigationContainerRef<RootStackParamList>()",
    );
    expect(e2eAppNavigationControllerSource).toContain(
      "Linking.getInitialURL()",
    );
    expect(e2eAppNavigationControllerSource).toContain(
      'Linking.addEventListener("url"',
    );
    expect(e2eAppNavigationControllerSource).toContain("screenNameFromE2eUrl");
    expect(e2eAppNavigationControllerSource).toContain("pendingScreen");
    expect(e2eAppRoutePathsSource).toContain("screenNameFromE2eUrl");
    expect(e2eAppRoutePathsSource).toContain(
      ".replace(/^hotupdaterexample:\\/\\//",
    );
    expect(e2eAppNavigationControllerSource).not.toContain("setTimeout");
    expect(e2eAppNavigationControllerSource).not.toMatch(/\bretry\b/i);
  });

  it("opens the screen needed by a testID through direct deep linking", async () => {
    const mobileDriverSource = await fs.readFile(mobileDriverPath, "utf8");
    const sharedScreenRoutesSource = await readSharedScreenRoutesSource();
    const openScreenBody = mobileDriverSource.slice(
      mobileDriverSource.indexOf("private async findVisible"),
      mobileDriverSource.indexOf("private async openApp"),
    );

    expect(mobileDriverSource).toContain("TEST_ID_SCREEN_PATHS");
    expect(mobileDriverSource).toContain("findVisible");
    expect(mobileDriverSource).toContain("device.openLink");
    expect(sharedScreenRoutesSource).toContain('"runtimeBundle"');
    expect(sharedScreenRoutesSource).toContain('"runtimeMarker"');
    expect(sharedScreenRoutesSource).toContain('"runtimeLargeAsset"');
    expect(sharedScreenRoutesSource).toContain('"cohortInput"');
    expect(sharedScreenRoutesSource).toContain('"runtimeChannelInput"');
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/action/install-current-channel-update",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/input/runtime-channel",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/input/cohort",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/action/set-cohort-qa",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-bundle",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-marker",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-large-asset",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/launch-status",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/launch-transition",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/crash-history",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-store-downloaded",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-store-download-paths",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/channel-action-result",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-action-result",
    );
    expect(sharedScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/cohort-action-result",
    );
    expect(openScreenBody).toContain("await this.options.device.openLink(");
    expect(openScreenBody).toContain("E2E_SCREEN_URLS");
    expect(openScreenBody).toContain('this.options.platform === "android"');
    expect(
      openScreenBody.indexOf("await this.openApp({ relaunch: false })"),
    ).toBeLessThan(
      openScreenBody.indexOf("await this.options.device.openLink("),
    );
    expect(openScreenBody).not.toContain("waitForActiveScreen");
    expect(openScreenBody).not.toContain(".tap()");
    expect(mobileDriverSource).not.toContain('by.id("e2e-active-screen")');
    expect(mobileDriverSource).not.toContain("E2E_SCREEN_CONTENT_TEST_IDS");
    expect(mobileDriverSource).not.toContain('by.id("e2e-screen-content")');
    expect(mobileDriverSource).not.toContain(".whileElement(");
    expect(mobileDriverSource).not.toContain(".scroll(");
  });

  it("registers native deep link schemes for mobile launch URLs", async () => {
    const androidManifest = await fs.readFile(androidManifestPath, "utf8");
    const iosAppDelegate = await fs.readFile(iosAppDelegatePath, "utf8");
    const iosInfoPlist = await fs.readFile(iosInfoPlistPath, "utf8");

    expect(androidManifest).toContain(
      'android:name="android.intent.action.VIEW"',
    );
    expect(androidManifest).toContain(
      'android:name="android.intent.category.BROWSABLE"',
    );
    expect(androidManifest).toContain('android:scheme="hotupdaterexample"');
    expect(iosInfoPlist).toContain("<key>CFBundleURLTypes</key>");
    expect(iosInfoPlist).toContain("<string>hotupdaterexample</string>");
    expect(iosAppDelegate).toContain("func application(");
    expect(iosAppDelegate).toContain("_ app: UIApplication");
    expect(iosAppDelegate).toContain("open url: URL");
    expect(iosAppDelegate).toContain(
      "options: [UIApplication.OpenURLOptionsKey: Any]",
    );
    expect(iosAppDelegate).toContain(
      "RCTLinkingManager.application(app, open: url, options: options)",
    );
  });
});

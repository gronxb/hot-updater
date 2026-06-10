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
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");
const detoxScreenRoutesPath = path.join(
  repoDir,
  "e2e/detox/detox-screen-routes.js",
);
const examplePackagePath = path.join(repoDir, "examples/v0.85.0/package.json");
const iosInfoPlistPath = path.join(
  repoDir,
  "examples/v0.85.0/ios/HotUpdaterExample/Info.plist",
);

describe("E2E navigation contract", () => {
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
    ) as { dependencies: Record<string, string> };

    expect(examplePackage.dependencies["@react-navigation/native"]).toBeTypeOf(
      "string",
    );
    expect(
      examplePackage.dependencies["@react-navigation/native-stack"],
    ).toBeTypeOf("string");
    expect(examplePackage.dependencies["react-native-screens"]).toBeTypeOf(
      "string",
    );
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
    expect(e2eAppScreenFiles).toContain("launch-crashed-bundle-screen.tsx");
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
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );
    const openScreenBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function openScreenForTestID"),
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
    );

    expect(detoxPageSource).toContain("screenPathForTestID");
    expect(detoxPageSource).toContain("openScreenForTestID");
    expect(detoxPageSource).toContain("openDeepLinkScreen");
    expect(detoxScreenRoutesSource).toContain('"runtimeBundle"');
    expect(detoxScreenRoutesSource).toContain('"runtimeMarker"');
    expect(detoxScreenRoutesSource).toContain('"runtimeLargeAsset"');
    expect(detoxScreenRoutesSource).toContain('"cohortInput"');
    expect(detoxScreenRoutesSource).toContain('"runtimeChannelInput"');
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/action/install-current-channel-update",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/input/runtime-channel",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/input/cohort",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/action/set-cohort-qa",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-bundle",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-marker",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-large-asset",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/launch-status",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/launch-crashed-bundle",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/crash-history",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-store-downloaded",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-store-download-paths",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/channel-action-result",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/update-action-result",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/cohort-action-result",
    );
    expect(openScreenBody).toContain("openDeepLinkScreen");
    expect(openScreenBody).toContain(
      "openDeepLinkScreen(E2E_SCREEN_URLS[screenPath])",
    );
    expect(
      openScreenBody.indexOf("withSynchronizationDisabledForPageOpen"),
    ).toBeLessThan(openScreenBody.indexOf("openDeepLinkScreen"));
    expect(detoxPageSource).toContain("async function openDeepLinkScreen");
    expect(detoxPageSource).toContain("if (isAndroidRun())");
    expect(detoxPageSource).toContain(
      "await launchApp({ newInstance: false, url });",
    );
    expect(detoxPageSource).toContain(
      "await launchApp({ newInstance: false });",
    );
    expect(detoxPageSource).toContain("await device.openURL({ url });");
    expect(
      detoxPageSource.indexOf("await launchApp({ newInstance: false });"),
    ).toBeLessThan(detoxPageSource.indexOf("await device.openURL({ url });"));
    expect(openScreenBody).not.toContain("waitForActiveScreen");
    expect(openScreenBody).not.toContain(".tap()");
    expect(detoxPageSource).not.toContain('by.id("e2e-active-screen")');
    expect(detoxPageSource).not.toContain("E2E_SCREEN_CONTENT_TEST_IDS");
    expect(detoxPageSource).not.toContain('by.id("e2e-screen-content")');
    expect(detoxPageSource).not.toContain(".whileElement(");
    expect(detoxPageSource).not.toContain(".scroll(");
  });

  it("registers native deep link schemes for Detox launch URLs", async () => {
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

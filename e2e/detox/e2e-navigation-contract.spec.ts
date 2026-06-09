import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const appPath = path.join(repoDir, "examples/v0.85.0/App.tsx");
const e2eAppIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/index.tsx",
);
const e2eAppPatchSurfacePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/patchSurface.ts",
);
const e2eAppScreensPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens.tsx",
);
const e2eAppComponentsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/components.tsx",
);
const androidManifestPath = path.join(
  repoDir,
  "examples/v0.85.0/android/app/src/main/AndroidManifest.xml",
);
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");
const examplePackagePath = path.join(repoDir, "examples/v0.85.0/package.json");
const iosInfoPlistPath = path.join(
  repoDir,
  "examples/v0.85.0/ios/HotUpdaterExample/Info.plist",
);

describe("E2E navigation contract", () => {
  it("uses React Navigation screens instead of one scroll-heavy E2E surface", async () => {
    const appSource = await fs.readFile(appPath, "utf8");
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppPatchSurfaceSource = await fs.readFile(
      e2eAppPatchSurfacePath,
      "utf8",
    );
    const e2eAppScreensSource = await fs.readFile(e2eAppScreensPath, "utf8");
    const e2eAppComponentsSource = await fs.readFile(
      e2eAppComponentsPath,
      "utf8",
    );
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
    expect(e2eAppIndexSource).toContain("NavigationContainer");
    expect(e2eAppIndexSource).toContain("createNativeStackNavigator");
    expect(e2eAppIndexSource).toContain("e2eLinking");
    expect(e2eAppScreensSource).toContain("RuntimeIdentityScreen");
    expect(e2eAppScreensSource).toContain("LaunchStatusScreen");
    expect(e2eAppScreensSource).toContain("InstallActionsScreen");
    expect(e2eAppScreensSource).toContain("RuntimeChannelActionsScreen");
    expect(e2eAppScreensSource).toContain("CohortInputActionsScreen");
    expect(e2eAppScreensSource).toContain("CohortPresetActionsScreen");
    expect(e2eAppScreensSource).toContain("ActionResultsScreen");
    expect(e2eAppComponentsSource).not.toContain("ScrollView");
    expect(e2eAppComponentsSource).not.toContain("ScreenTabs");
    expect(e2eAppComponentsSource).not.toContain("e2e-nav-");
    expect(e2eAppComponentsSource).toContain(
      "testID={screenContentTestIDs[current]}",
    );
    expect(e2eAppIndexSource).toContain("hotupdaterexample://");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_SCENARIO_MARKER");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_CRASH_GUARD_START");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_DEPLOY_ASSET_GUARD_START");
    expect(appSource).not.toContain("sectionOffsets");
    expect(appSource).not.toContain("scrollToSection");
  });

  it("opens the screen needed by a testID through direct deep linking", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const openScreenBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function openScreenForTestID"),
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
    );

    expect(detoxPageSource).toContain("screenPathForTestID");
    expect(detoxPageSource).toContain("openScreenForTestID");
    expect(detoxPageSource).toContain("device.openURL({");
    expect(detoxPageSource).toContain('"runtimeIdentity"');
    expect(detoxPageSource).toContain('"cohortInputActions"');
    expect(detoxPageSource).toContain('"runtimeChannelActions"');
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/install");
    expect(detoxPageSource).toContain(
      "hotupdaterexample://e2e/runtime-channel",
    );
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/cohort-input");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/cohort-presets");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/results");
    expect(detoxPageSource).toContain(
      "hotupdaterexample://e2e/runtime-identity",
    );
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/launch-status");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/crash-history");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/update-store");
    expect(openScreenBody).toContain("device.openURL({");
    expect(openScreenBody).toContain("url: E2E_SCREEN_URLS[screenPath]");
    expect(openScreenBody).not.toContain("launchApp({");
    expect(openScreenBody).toContain(
      "await waitForActiveScreen(E2E_SCREEN_CONTENT_TEST_IDS[screenPath])",
    );
    expect(openScreenBody).not.toContain(".tap()");
    expect(detoxPageSource).not.toContain('by.id("e2e-active-screen")');
    expect(detoxPageSource).toContain("E2E_SCREEN_CONTENT_TEST_IDS");
    expect(detoxPageSource).toContain('by.id("e2e-screen-content")');
    expect(detoxPageSource).not.toContain(".whileElement(");
    expect(detoxPageSource).not.toContain(".scroll(");
  });

  it("registers native deep link schemes for Detox launch URLs", async () => {
    const androidManifest = await fs.readFile(androidManifestPath, "utf8");
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
  });
});

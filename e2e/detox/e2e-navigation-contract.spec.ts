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
    expect(e2eAppScreensSource).toContain("RuntimeScreen");
    expect(e2eAppScreensSource).toContain("ActionsScreen");
    expect(e2eAppScreensSource).toContain("CohortActionsScreen");
    expect(e2eAppScreensSource).toContain("ResultsScreen");
    expect(e2eAppIndexSource).toContain("hotupdaterexample://");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_SCENARIO_MARKER");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_CRASH_GUARD_START");
    expect(e2eAppPatchSurfaceSource).toContain("E2E_DEPLOY_ASSET_GUARD_START");
    expect(appSource).not.toContain("sectionOffsets");
    expect(appSource).not.toContain("scrollToSection");
  });

  it("opens the screen needed by a testID through deep linking and visible navigation", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");

    expect(detoxPageSource).toContain("screenPathForTestID");
    expect(detoxPageSource).toContain("openScreenForTestID");
    expect(detoxPageSource).toContain("navTargetForScreenPath");
    expect(detoxPageSource).toContain('waitForActiveScreen("Actions")');
    expect(detoxPageSource).toContain('waitForActiveScreen("CohortActions")');
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/actions");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/cohorts");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/results");
    expect(detoxPageSource).toContain("hotupdaterexample://e2e/runtime");
    expect(detoxPageSource).toContain("await element(by.id(navTarget)).tap()");
    expect(detoxPageSource).toContain('by.id("e2e-active-screen")');
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

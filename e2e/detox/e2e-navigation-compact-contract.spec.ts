import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const e2eAppIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/index.tsx",
);
const e2eAppRoutePathsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/route-paths.ts",
);
const e2eAppRoutesPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes.tsx",
);
const e2eAppRegisteredRouteElementsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/registered-route-elements.tsx",
);
const e2eAppRouteElementsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes/route-elements.tsx",
);
const e2eAppScreensIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/index.ts",
);
const e2eAppTopLevelScreensPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens.tsx",
);
const e2eAppScreenTestIDsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screen-test-ids.ts",
);
const e2eAppComponentsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/components.tsx",
);
const e2eAppStylesPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/styles.ts",
);
const e2eAppScreensDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens",
);
const e2eAppSourceDir = path.join(repoDir, "examples/v0.85.0/src/e2eApp");
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");
const detoxScreenRoutesPath = path.join(
  repoDir,
  "e2e/detox/detox-screen-routes.js",
);

const sourceCodeLineCount = (source: string): number =>
  source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//");
  }).length;

const collectSourceFiles = async (dir: string): Promise<readonly string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(entryPath);
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat();
};

describe("E2E navigation compact surface contract", () => {
  it("keeps the default page and assertion routes compact", async () => {
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppRoutePathsSource = await fs.readFile(
      e2eAppRoutePathsPath,
      "utf8",
    );

    expect(e2eAppRoutePathsSource).toContain('Ready: "e2e/ready"');
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeBundle: "e2e/runtime-bundle"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeMarker: "e2e/runtime-marker"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeLargeAsset: "e2e/runtime-large-asset"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeCurrentChannel: "e2e/runtime-current-channel"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeDefaultChannel: "e2e/runtime-default-channel"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeChannelSwitched: "e2e/runtime-channel-switched"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeCurrentCohort: "e2e/runtime-current-cohort"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'RuntimeInitialCohort: "e2e/runtime-initial-cohort"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'CrashHistoryCount: "e2e/crash-history-count"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'LaunchCrashedBundle: "e2e/launch-crashed-bundle"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'ChannelActionResult: "e2e/channel-action-result"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'UpdateActionResult: "e2e/update-action-result"',
    );
    expect(e2eAppRoutePathsSource).toContain(
      'CohortActionResult: "e2e/cohort-action-result"',
    );
    expect(e2eAppIndexSource).not.toContain("RuntimeIdentity");
    expect(e2eAppIndexSource).not.toContain("ActionResults");
    await expect(fs.stat(e2eAppScreenTestIDsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(e2eAppTopLevelScreensPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(e2eAppScreensIndexPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not keep a central screen-content registry for assertions", async () => {
    const e2eAppComponentsSource = await fs.readFile(
      e2eAppComponentsPath,
      "utf8",
    );
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );

    expect(e2eAppComponentsSource).not.toContain("screenContentTestIDs");
    expect(e2eAppComponentsSource).not.toContain("current: ScreenName");
    expect(detoxPageSource).not.toContain("waitForActiveScreen");
    expect(detoxScreenRoutesSource).not.toContain(
      "E2E_SCREEN_CONTENT_TEST_IDS",
    );
    await expect(fs.stat(e2eAppScreenTestIDsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the default E2E page as a ready-only route", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const registeredRouteElementsSource = await fs.readFile(
      e2eAppRegisteredRouteElementsPath,
      "utf8",
    );
    const routeElementsSource = await fs.readFile(
      e2eAppRouteElementsPath,
      "utf8",
    );
    const readyScreenSource = await fs.readFile(
      path.join(e2eAppScreensDir, "ready-screen.tsx"),
      "utf8",
    );

    expect(e2eAppRoutesSource).toContain('initialRouteName="Ready"');
    expect(e2eAppRoutesSource).toContain("contentStyle: styles.content");
    expect(e2eAppRoutesSource).not.toContain("testID=");
    expect(e2eAppRoutesSource).not.toContain("ScrollView");
    expect(e2eAppRoutesSource).not.toContain("ScreenShell");
    expect(registeredRouteElementsSource).not.toContain("testID=");
    expect(registeredRouteElementsSource).not.toContain("ScrollView");
    expect(registeredRouteElementsSource).not.toContain("ScreenShell");
    expect(routeElementsSource).not.toContain('-route"');
    expect(routeElementsSource).not.toContain("-route';");
    expect(sourceCodeLineCount(routeElementsSource)).toBeLessThanOrEqual(14);
    expect(readyScreenSource.match(/testID=/g) ?? []).toHaveLength(1);
    expect(readyScreenSource).toContain('testID="e2e-ready-status"');
    expect(readyScreenSource).toContain('value="Ready"');
    expect(readyScreenSource).not.toContain("ScreenShell");
    expect(readyScreenSource).not.toContain("SafeAreaView");
    expect(sourceCodeLineCount(readyScreenSource)).toBeLessThanOrEqual(6);
  });

  it("keeps the full E2E app surface free of scroll containers", async () => {
    const sourceFiles = await collectSourceFiles(e2eAppSourceDir);
    const scrollContainerFindings: string[] = [];

    for (const filePath of sourceFiles) {
      const source = await fs.readFile(filePath, "utf8");
      if (/\b(ScrollView|FlatList|SectionList)\b/.test(source)) {
        scrollContainerFindings.push(path.relative(repoDir, filePath));
      }
    }

    expect(scrollContainerFindings).toEqual([]);
  });

  it("keeps E2E route pages free of a shared screen shell", async () => {
    // Given: route-level pages should not render through one long shared page.
    const sourceFiles = await collectSourceFiles(e2eAppSourceDir);
    const screenShellFindings: string[] = [];

    // When: all E2E app sources are inspected for the old shell abstraction.
    for (const filePath of sourceFiles) {
      const source = await fs.readFile(filePath, "utf8");
      if (/\bScreenShell\b/.test(source)) {
        screenShellFindings.push(path.relative(repoDir, filePath));
      }
    }

    // Then: styling is owned by the navigator, and each screen owns one target.
    expect(screenShellFindings).toEqual([]);
  });

  it("keeps runtime assertion pages as screen-sized files", async () => {
    // Given: runtime assertion pages are the highest-traffic Detox targets.
    const screenFiles = await fs.readdir(e2eAppScreensDir);

    // When: the implementation is inspected for bundled assertion surfaces.
    const runtimeScreenFiles = screenFiles.filter(
      (fileName) =>
        fileName.startsWith("runtime-") &&
        !fileName.includes("-action-") &&
        !fileName.includes("-input-"),
    );

    // Then: each assertion page lives in its own small file.
    expect(screenFiles).not.toContain("runtime-screens.tsx");
    expect(runtimeScreenFiles).toEqual([
      "runtime-bundle-screen.tsx",
      "runtime-channel-switched-screen.tsx",
      "runtime-current-channel-screen.tsx",
      "runtime-current-cohort-screen.tsx",
      "runtime-default-channel-screen.tsx",
      "runtime-initial-cohort-screen.tsx",
      "runtime-large-asset-screen.tsx",
      "runtime-marker-screen.tsx",
    ]);

    for (const fileName of [
      ...runtimeScreenFiles,
      "crash-history-count-screen.tsx",
      "launch-crashed-bundle-screen.tsx",
      "launch-status-screen.tsx",
      "update-store-downloaded-screen.tsx",
      "update-store-download-paths-screen.tsx",
    ]) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      expect(source).not.toContain("ScrollView");
      expect(sourceCodeLineCount(source)).toBeLessThanOrEqual(70);
    }
  });

  it("keeps every E2E route page in a small non-scrollable file", async () => {
    // Given: Detox opens one route per assertion or action target.
    const screenFiles = (await fs.readdir(e2eAppScreensDir)).filter(
      (fileName) => fileName.endsWith(".tsx"),
    );

    // When: the route page files are inspected for hidden bundled pages.
    // Then: no screen file needs ScrollView lookup or a large registry body.
    expect(screenFiles).not.toContain("action-screens.tsx");
    for (const fileName of screenFiles) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      expect(source).not.toContain("ScrollView");
      expect(sourceCodeLineCount(source)).toBeLessThanOrEqual(70);
    }
  });

  it("keeps every concrete E2E route screen to one Detox target", async () => {
    // Given: each deep link should render only the target Detox needs.
    const screenFiles = (await fs.readdir(e2eAppScreensDir)).filter(
      (fileName) =>
        fileName.endsWith("-screen.tsx") &&
        fileName !== "action-button-screen.tsx",
    );

    // When: the individual route screen files are inspected.
    // Then: every concrete screen exposes exactly one testID target.
    for (const fileName of screenFiles) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      expect(source.match(/testID=/g) ?? [], fileName).toHaveLength(1);
    }
  });

  it("keeps E2E route pages free of decorative section wrappers", async () => {
    // Given: Detox opens each deep link to assert or tap one visible target.
    const screenFiles = (await fs.readdir(e2eAppScreensDir)).filter(
      (fileName) => fileName.endsWith(".tsx"),
    );

    // When: route page files are inspected for extra layout surfaces.
    // Then: each page renders the target directly instead of a titled section.
    for (const fileName of screenFiles) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      expect(source, fileName).not.toContain("Section");
      expect(source, fileName).not.toContain("section-");
    }
  });

  it("removes old long-page styles from the E2E app surface", async () => {
    const e2eAppStylesSource = await fs.readFile(e2eAppStylesPath, "utf8");

    for (const obsoleteStyleName of [
      "assetCard",
      "assetHash",
      "assetName",
      "buttonGrid",
      "crashList",
      "crashItem",
      "description",
      "imageFrame",
      "previewImage",
      "safeArea",
      "title",
    ]) {
      expect(e2eAppStylesSource, obsoleteStyleName).not.toContain(
        `${obsoleteStyleName}:`,
      );
    }
  });

  it("keeps assertion route pages target-only instead of label/value rows", async () => {
    const assertionScreenFiles = [
      "crash-history-count-screen.tsx",
      "runtime-bundle-screen.tsx",
      "runtime-channel-switched-screen.tsx",
      "runtime-current-channel-screen.tsx",
      "runtime-current-cohort-screen.tsx",
      "runtime-default-channel-screen.tsx",
      "runtime-initial-cohort-screen.tsx",
      "runtime-large-asset-screen.tsx",
      "runtime-marker-screen.tsx",
      "update-store-downloaded-screen.tsx",
      "update-store-download-paths-screen.tsx",
    ];

    for (const fileName of assertionScreenFiles) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      expect(source, fileName).not.toContain("InfoRow");
      expect(source, fileName).toContain("ValueText");
    }
  });

  it("keeps each E2E route screen in its own file", async () => {
    const screenFiles = (await fs.readdir(e2eAppScreensDir)).filter(
      (fileName) => fileName.endsWith(".tsx"),
    );

    expect(screenFiles).not.toContain("cohort-action-screens.tsx");
    expect(screenFiles).not.toContain("crash-action-screens.tsx");
    expect(screenFiles).not.toContain("input-screens.tsx");
    expect(screenFiles).not.toContain("install-action-screens.tsx");
    expect(screenFiles).not.toContain("launch-screens.tsx");
    expect(screenFiles).not.toContain("result-screens.tsx");
    expect(screenFiles).not.toContain("runtime-action-screens.tsx");
    expect(screenFiles).not.toContain("update-store-screens.tsx");

    for (const fileName of screenFiles) {
      if (fileName === "action-button-screen.tsx" || fileName === "types.ts") {
        continue;
      }

      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      const exportedScreens = source.match(/export const \w+Screen/g) ?? [];
      expect(exportedScreens, fileName).toHaveLength(1);
    }
  });

  it("does not swallow E2E action button errors", async () => {
    const e2eAppComponentsSource = await fs.readFile(
      e2eAppComponentsPath,
      "utf8",
    );
    const buttonBody = e2eAppComponentsSource.slice(
      e2eAppComponentsSource.indexOf("export const Button"),
      e2eAppComponentsSource.indexOf("export const FocusedActionRoute"),
    );

    expect(buttonBody).toContain("void onPress()");
    expect(buttonBody).not.toContain("catch(() => undefined)");
  });

  it("keeps Detox page helpers from becoming the screen route registry", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );

    expect(detoxPageSource).toContain("screenPathForTestID");
    expect(detoxPageSource).not.toContain(
      "const E2E_SCREEN_CONTENT_TEST_IDS =",
    );
    expect(detoxPageSource).not.toContain("const E2E_SCREEN_URLS =");
    expect(detoxScreenRoutesSource).toContain("const E2E_SCREEN_URLS =");
    expect(detoxScreenRoutesSource).toContain("screenPathForTestID");
    expect(detoxScreenRoutesSource).toContain(
      'ready: "hotupdaterexample://e2e/ready"',
    );
    expect(detoxScreenRoutesSource).toContain(
      'return TEST_ID_SCREEN_PATHS[testID] || "ready";',
    );
    expect(detoxScreenRoutesSource).not.toContain('|| "runtimeBundle"');
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-marker",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-current-channel",
    );
    expect(detoxScreenRoutesSource).not.toContain("runtime-channel-summary");
    expect(detoxScreenRoutesSource).not.toContain("current-channel-summary");
  });
});

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
const e2eAppScreensDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens",
);
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
      e2eAppComponentsSource.indexOf("export const ScreenShell"),
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
      "hotupdaterexample://e2e/runtime-marker",
    );
    expect(detoxScreenRoutesSource).toContain(
      "hotupdaterexample://e2e/runtime-current-channel",
    );
    expect(detoxScreenRoutesSource).not.toContain("runtime-channel-summary");
    expect(detoxScreenRoutesSource).not.toContain("current-channel-summary");
  });
});

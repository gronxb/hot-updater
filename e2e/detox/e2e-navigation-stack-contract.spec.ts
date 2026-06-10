import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const exampleAppPath = path.join(repoDir, "examples/v0.85.0/App.tsx");
const e2eAppIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/index.tsx",
);
const e2eAppShellPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/app-shell.tsx",
);
const e2eAppNavigationControllerPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/navigation-controller.ts",
);
const e2eAppNavigationFallbackPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/navigation-fallback.tsx",
);
const e2eAppReadyScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/ready-screen.tsx",
);
const e2eAppRouteGroupDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routeGroups",
);
const e2eAppRouteModulesDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes",
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
const e2eAppRouteRegistryDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes/registry",
);
const e2eAppStackScreensPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/stack-screens.tsx",
);
const e2eAppStackScreensDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/stackScreens",
);
const e2eAppRuntimeModelContextPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/runtime-model-context.tsx",
);
const e2eAppSourceDir = path.join(repoDir, "examples/v0.85.0/src/e2eApp");

const sourceCodeLineCount = (source: string): number =>
  source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//");
  }).length;

describe("E2E navigation stack contract", () => {
  it("keeps the example App entrypoint as a thin E2E shell", async () => {
    const exampleAppSource = await fs.readFile(exampleAppPath, "utf8");

    expect(exampleAppSource).toContain("E2eHotUpdaterApp");
    expect(exampleAppSource).toContain("E2E_SCENARIO_MARKER");
    expect(exampleAppSource).not.toContain("ScrollView");
    expect(exampleAppSource).not.toContain("Stack.Navigator");
    expect(exampleAppSource).not.toContain("Stack.Screen");
    expect(exampleAppSource).not.toContain("testID=");
    expect(exampleAppSource).not.toContain("RuntimeBundleScreen");
    expect(exampleAppSource).not.toContain("InstallCurrentChannelUpdate");
    expect(sourceCodeLineCount(exampleAppSource)).toBeLessThanOrEqual(18);
  });

  it("keeps the ready route out of assertion and action surfaces", async () => {
    const e2eAppScreensSource = await fs.readFile(
      e2eAppReadyScreenPath,
      "utf8",
    );
    const readyScreenBody = e2eAppScreensSource.slice(
      e2eAppScreensSource.indexOf("export const ReadyScreen"),
      e2eAppScreensSource.length,
    );

    expect(readyScreenBody).not.toContain("<SafeAreaView");
    expect(readyScreenBody).not.toContain("<ScreenShell>");
    expect(readyScreenBody).toContain("<ValueText");
    expect(readyScreenBody).toContain('testID="e2e-ready-status"');
    expect(readyScreenBody.match(/testID=/g) ?? []).toHaveLength(1);
    expect(readyScreenBody).not.toContain("RuntimeBundleScreen");
    expect(readyScreenBody).not.toContain("RuntimeMarkerScreen");
    expect(readyScreenBody).not.toContain("ActionScreen");
    expect(readyScreenBody).not.toContain("InfoRow");
    expect(readyScreenBody).not.toContain("Button");
    expect(readyScreenBody).not.toContain("<Text");
    expect(readyScreenBody).not.toContain("styles.");
    expect(sourceCodeLineCount(readyScreenBody)).toBeLessThanOrEqual(6);
  });

  it("keeps the app entrypoint and stack container from becoming scenario screen registries", async () => {
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppShellSource = await fs.readFile(e2eAppShellPath, "utf8");
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppRuntimeModelContextSource = await fs.readFile(
      e2eAppRuntimeModelContextPath,
      "utf8",
    );

    expect(e2eAppIndexSource).toBe(
      'export { E2eHotUpdaterApp } from "./app-shell";\n',
    );
    expect(e2eAppIndexSource).not.toContain("NavigationContainer");
    expect(e2eAppIndexSource).not.toContain("useE2eRuntimeModel");
    expect(e2eAppIndexSource).not.toContain("useE2eDeepLinks");
    expect(e2eAppIndexSource).not.toContain("Stack.Navigator");
    expect(e2eAppIndexSource).not.toContain("Stack.Screen");
    expect(e2eAppIndexSource).not.toContain("e2e/action/");
    expect(e2eAppIndexSource).not.toContain("e2e/runtime-");
    expect(e2eAppIndexSource).not.toContain("RuntimeBundleScreen");
    expect(e2eAppIndexSource).not.toContain("InstallCurrentChannelUpdate");
    expect(e2eAppIndexSource).not.toContain("SafeAreaView");
    expect(e2eAppIndexSource).not.toContain("Text");
    expect(e2eAppIndexSource).not.toContain("styles.");
    expect(e2eAppIndexSource).not.toContain("testID=");
    expect(sourceCodeLineCount(e2eAppIndexSource)).toBeLessThanOrEqual(3);
    expect(e2eAppShellSource).toContain("E2eStack");
    expect(e2eAppShellSource).toContain("E2eRuntimeModelProvider");
    expect(e2eAppShellSource).toContain("NavigationContainer");
    expect(e2eAppShellSource).toContain("useE2eRuntimeModel");
    expect(e2eAppShellSource).toContain("useE2eDeepLinks");
    expect(e2eAppShellSource).not.toContain("Stack.Screen");
    expect(e2eAppShellSource).not.toContain("testID=");
    expect(sourceCodeLineCount(e2eAppShellSource)).toBeLessThanOrEqual(40);
    const e2eAppNavigationFallbackSource = await fs.readFile(
      e2eAppNavigationFallbackPath,
      "utf8",
    );
    expect(e2eAppNavigationFallbackSource).toContain(
      'testID="e2e-navigation-loading"',
    );
    expect(
      sourceCodeLineCount(e2eAppNavigationFallbackSource),
    ).toBeLessThanOrEqual(12);
    expect(e2eAppRoutesSource).toContain("contentStyle: styles.content");
    expect(e2eAppRoutesSource).not.toContain("e2e/action/");
    expect(e2eAppRoutesSource).not.toContain("e2e/runtime-");
    expect(e2eAppRoutesSource).not.toContain("RuntimeBundleScreen");
    expect(e2eAppRoutesSource).not.toContain(
      "InstallCurrentChannelUpdateActionScreen",
    );
    expect(e2eAppRoutesSource).not.toContain("modelScreens");
    expect(e2eAppRoutesSource).not.toContain("screen.render(model)");
    expect(e2eAppRoutesSource).not.toContain("{() =>");
    expect(e2eAppRoutesSource).not.toContain("routeScreens");
    expect(e2eAppRoutesSource).not.toContain("routeGroups");
    expect(e2eAppRoutesSource).not.toContain("assertionRouteScreens");
    expect(e2eAppRoutesSource).not.toContain("interactionRouteScreens");
    expect(e2eAppRoutesSource).not.toContain("RuntimeChannelSummary");
    expect(e2eAppRoutesSource).not.toContain("RuntimeCohortSummary");
    expect(e2eAppRoutesSource).not.toContain("CrashHistoryScreen");
    expect(e2eAppRoutesSource).not.toContain("./routes/");
    expect(sourceCodeLineCount(e2eAppRoutesSource)).toBeLessThanOrEqual(20);
    expect(e2eAppRuntimeModelContextSource).toContain(
      "createContext<E2eRuntimeModel | null>",
    );
    expect(e2eAppRuntimeModelContextSource).toContain(
      "useE2eRuntimeModelContext",
    );
    await expect(fs.stat(e2eAppStackScreensPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(e2eAppStackScreensDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(e2eAppRouteGroupDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the route registrar outside the stack shell", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppRegisteredRouteElementsSource = await fs.readFile(
      e2eAppRegisteredRouteElementsPath,
      "utf8",
    );
    const e2eAppRouteElementsSource = await fs.readFile(
      e2eAppRouteElementsPath,
      "utf8",
    );

    expect(e2eAppRoutesSource).toContain("registeredRouteElements");
    expect(e2eAppRoutesSource).not.toContain("appActionRoutes");
    expect(e2eAppRoutesSource).not.toContain("cohortActionRoutes");
    expect(e2eAppRoutesSource).not.toContain("runtimeBundleRoutes");
    expect(e2eAppRoutesSource).not.toContain("statusResultRoutes");
    expect(e2eAppRegisteredRouteElementsSource).toContain("routeElements");
    expect(
      sourceCodeLineCount(e2eAppRegisteredRouteElementsSource),
    ).toBeLessThanOrEqual(5);
    expect(e2eAppRouteElementsSource).toContain("readyRouteElements");
    expect(e2eAppRouteElementsSource).toContain("actionRouteElements");
    expect(e2eAppRouteElementsSource).not.toContain("readyRoute,");
    expect(e2eAppRouteElementsSource).not.toContain("reloadAppActionRoute");
    expect(e2eAppRegisteredRouteElementsSource).not.toContain("readyRoutes");
    expect(e2eAppRegisteredRouteElementsSource).not.toContain(
      "appActionRoutes",
    );
    expect(e2eAppRegisteredRouteElementsSource).not.toContain(
      "cohortActionRoutes",
    );
    expect(e2eAppRegisteredRouteElementsSource).not.toContain(
      "runtimeBundleRoutes",
    );
    expect(e2eAppRegisteredRouteElementsSource).not.toContain(
      "statusResultRoutes",
    );
    expect(e2eAppRegisteredRouteElementsSource).not.toContain(
      "Stack.Navigator",
    );
    expect(e2eAppRegisteredRouteElementsSource).not.toContain("ScrollView");
  });

  it("keeps route registry files from becoming bundled main pages", async () => {
    const routeRegistryFiles = (await fs.readdir(e2eAppRouteRegistryDir))
      .filter((fileName) => fileName.endsWith(".tsx"))
      .sort();

    for (const fileName of routeRegistryFiles) {
      const source = await fs.readFile(
        path.join(e2eAppRouteRegistryDir, fileName),
        "utf8",
      );
      const concreteRouteImports = source.match(/from "\.\.\/.+-route"/g) ?? [];

      expect(source, fileName).not.toContain("Stack.Screen");
      expect(source, fileName).not.toContain("ScrollView");
      expect(concreteRouteImports.length, fileName).toBeLessThanOrEqual(3);
      expect(sourceCodeLineCount(source), fileName).toBeLessThanOrEqual(10);
    }
  });

  it("replaces the stack when opening a deep-linked test screen", async () => {
    const e2eAppNavigationControllerSource = await fs.readFile(
      e2eAppNavigationControllerPath,
      "utf8",
    );
    const navigateE2eScreenBody = e2eAppNavigationControllerSource.slice(
      e2eAppNavigationControllerSource.indexOf(
        "export const navigateE2eScreen",
      ),
      e2eAppNavigationControllerSource.indexOf(
        "export const handleE2eDeepLink",
      ),
    );

    expect(navigateE2eScreenBody).toContain("CommonActions.reset");
    expect(navigateE2eScreenBody).toContain("routes: [{ name: screen }]");
    expect(navigateE2eScreenBody).not.toContain("CommonActions.navigate");
  });

  it("keeps stack routes split into small React Navigation route modules", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const groupedRouteModuleFiles = (await fs.readdir(e2eAppRouteModulesDir))
      .filter((fileName) => fileName.endsWith("-routes.tsx"))
      .sort();
    const routeModuleFiles = (await fs.readdir(e2eAppRouteModulesDir))
      .filter((fileName) => fileName.endsWith("-route.tsx"))
      .sort();
    const routeModuleSources = await Promise.all(
      routeModuleFiles.map((fileName) =>
        fs.readFile(path.join(e2eAppRouteModulesDir, fileName), "utf8"),
      ),
    );
    expect(groupedRouteModuleFiles).toEqual([]);
    expect(routeModuleFiles).toEqual([
      "apply-cohort-input-action-route.tsx",
      "channel-action-result-route.tsx",
      "clear-crash-history-action-route.tsx",
      "cohort-action-result-route.tsx",
      "cohort-input-route.tsx",
      "crash-history-count-route.tsx",
      "install-current-channel-update-action-route.tsx",
      "install-runtime-channel-update-action-route.tsx",
      "launch-crashed-bundle-route.tsx",
      "launch-status-route.tsx",
      "ready-route.tsx",
      "refresh-runtime-snapshot-action-route.tsx",
      "reload-app-action-route.tsx",
      "reset-runtime-channel-action-route.tsx",
      "restore-initial-cohort-action-route.tsx",
      "runtime-bundle-route.tsx",
      "runtime-channel-input-route.tsx",
      "runtime-channel-switched-route.tsx",
      "runtime-current-channel-route.tsx",
      "runtime-current-cohort-route.tsx",
      "runtime-default-channel-route.tsx",
      "runtime-initial-cohort-route.tsx",
      "runtime-large-asset-route.tsx",
      "runtime-marker-route.tsx",
      "set-cohort-qa-action-route.tsx",
      "update-action-result-route.tsx",
      "update-store-download-paths-route.tsx",
      "update-store-downloaded-route.tsx",
    ]);
    const stackScreens = routeModuleSources.flatMap(
      (source) => source.match(/<Stack\.Screen/g) ?? [],
    );
    expect(stackScreens).toHaveLength(28);
    expect(e2eAppRoutesSource).not.toContain("routeGroups");
    expect(e2eAppRoutesSource).not.toContain("routeScreens");
    for (const [index, source] of routeModuleSources.entries()) {
      const fileName = routeModuleFiles[index];
      const routeScreenCount = source.match(/<Stack\.Screen/g) ?? [];
      expect(routeScreenCount.length, fileName).toBe(1);
      expect(source).not.toContain("ScrollView");
      expect(source).not.toContain("Section");
      expect(sourceCodeLineCount(source), fileName).toBeLessThanOrEqual(12);
    }
    await expect(fs.stat(e2eAppRouteGroupDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps E2E app source modules below the page-sized LOC ceiling", async () => {
    const collectSourceFiles = async (dir: string): Promise<string[]> => {
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
    const sourceFiles = await collectSourceFiles(e2eAppSourceDir);
    const lineCounts = await Promise.all(
      sourceFiles.map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        return {
          filePath: path.relative(repoDir, filePath),
          lines: sourceCodeLineCount(source),
        };
      }),
    );

    expect(
      lineCounts
        .filter(({ lines }) => lines > 250)
        .map(({ filePath, lines }) => `${filePath}: ${lines}`),
    ).toEqual([]);
  });
});

import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const e2eAppIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/index.tsx",
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

const sourceCodeLineCount = (source: string): number =>
  source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//");
  }).length;

describe("E2E navigation stack contract", () => {
  it("keeps the ready route out of assertion and action surfaces", async () => {
    const e2eAppScreensSource = await fs.readFile(
      e2eAppReadyScreenPath,
      "utf8",
    );
    const readyScreenBody = e2eAppScreensSource.slice(
      e2eAppScreensSource.indexOf("export const ReadyScreen"),
      e2eAppScreensSource.length,
    );

    expect(readyScreenBody).toContain("<ScreenShell>");
    expect(readyScreenBody).toContain('testID="e2e-ready-status"');
    expect(readyScreenBody).not.toContain("RuntimeBundleScreen");
    expect(readyScreenBody).not.toContain("RuntimeMarkerScreen");
    expect(readyScreenBody).not.toContain("ActionScreen");
    expect(readyScreenBody).not.toContain("InfoRow");
    expect(readyScreenBody).not.toContain("Button");
    expect(sourceCodeLineCount(readyScreenBody)).toBeLessThanOrEqual(14);
  });

  it("keeps the app entrypoint and stack container from becoming scenario screen registries", async () => {
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppRuntimeModelContextSource = await fs.readFile(
      e2eAppRuntimeModelContextPath,
      "utf8",
    );

    expect(e2eAppIndexSource).toContain("E2eStack");
    expect(e2eAppIndexSource).toContain("E2eRuntimeModelProvider");
    expect(e2eAppIndexSource).not.toContain("Stack.Navigator");
    expect(e2eAppIndexSource).not.toContain("Stack.Screen");
    expect(e2eAppIndexSource).not.toContain("e2e/action/");
    expect(e2eAppIndexSource).not.toContain("e2e/runtime-");
    expect(e2eAppIndexSource).not.toContain("RuntimeBundleScreen");
    expect(e2eAppIndexSource).not.toContain("InstallCurrentChannelUpdate");
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
    expect(sourceCodeLineCount(e2eAppRoutesSource)).toBeLessThanOrEqual(35);
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

  it("keeps stack routes split into small React Navigation route modules", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const routeModuleFiles = (await fs.readdir(e2eAppRouteModulesDir))
      .filter((fileName) => fileName.endsWith("-routes.tsx"))
      .sort();
    const routeModuleSources = await Promise.all(
      routeModuleFiles.map((fileName) =>
        fs.readFile(path.join(e2eAppRouteModulesDir, fileName), "utf8"),
      ),
    );
    expect(routeModuleFiles).toEqual([
      "app-action-routes.tsx",
      "cohort-action-routes.tsx",
      "input-routes.tsx",
      "install-action-routes.tsx",
      "ready-routes.tsx",
      "runtime-action-routes.tsx",
      "runtime-bundle-routes.tsx",
      "runtime-channel-routes.tsx",
      "runtime-cohort-routes.tsx",
      "status-launch-routes.tsx",
      "status-result-routes.tsx",
      "status-update-store-routes.tsx",
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
      expect(routeScreenCount.length, fileName).toBeLessThanOrEqual(4);
      expect(source).not.toContain("ScrollView");
      expect(source).not.toContain("Section");
      expect(sourceCodeLineCount(source), fileName).toBeLessThanOrEqual(80);
    }
    await expect(fs.stat(e2eAppRouteGroupDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

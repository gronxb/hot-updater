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

  it("keeps the app entrypoint from becoming a scenario screen registry", async () => {
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
    expect(e2eAppRoutesSource).not.toContain("modelScreens");
    expect(e2eAppRoutesSource).not.toContain("screen.render(model)");
    expect(e2eAppRoutesSource).not.toContain("{() =>");
    expect(e2eAppRoutesSource).not.toContain("routeScreens");
    expect(e2eAppRoutesSource).not.toContain("routeGroups");
    expect(e2eAppRoutesSource).toContain("component={RuntimeBundleScreen}");
    expect(e2eAppRoutesSource).toContain(
      "component={RuntimeCurrentChannelScreen}",
    );
    expect(e2eAppRoutesSource).toContain(
      "component={RuntimeCurrentCohortScreen}",
    );
    expect(e2eAppRoutesSource).toContain("component={LaunchStatusScreen}");
    expect(e2eAppRoutesSource).toContain(
      "component={UpdateStoreDownloadedScreen}",
    );
    expect(e2eAppRoutesSource).toContain(
      "component={ChannelActionResultScreen}",
    );
    expect(e2eAppRoutesSource).toContain(
      "component={InstallCurrentChannelUpdateActionScreen}",
    );
    expect(e2eAppRoutesSource).toContain(
      "component={RefreshRuntimeSnapshotActionScreen}",
    );
    expect(e2eAppRoutesSource).toContain(
      "component={ResetRuntimeChannelActionScreen}",
    );
    expect(e2eAppRoutesSource).toContain("component={CohortInputScreen}");
    expect(e2eAppRoutesSource).toContain("component={SetCohortQaActionScreen}");
    expect(e2eAppRoutesSource).not.toContain("assertionRouteScreens");
    expect(e2eAppRoutesSource).not.toContain("interactionRouteScreens");
    expect(e2eAppRoutesSource).not.toContain("RuntimeChannelSummary");
    expect(e2eAppRoutesSource).not.toContain("RuntimeCohortSummary");
    expect(e2eAppRoutesSource).not.toContain("CrashHistoryScreen");
    expect(sourceCodeLineCount(e2eAppRoutesSource)).toBeLessThanOrEqual(140);
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

  it("keeps stack routes direct instead of hiding them in route group layers", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const stackScreens = e2eAppRoutesSource.match(/<Stack\.Screen/g) ?? [];

    expect(stackScreens).toHaveLength(28);
    expect(e2eAppRoutesSource).not.toContain("routeGroups");
    expect(e2eAppRoutesSource).not.toContain("routeScreens");
    await expect(fs.stat(e2eAppRouteGroupDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

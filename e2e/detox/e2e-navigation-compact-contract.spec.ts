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
const e2eAppRoutesPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/routes.tsx",
);
const e2eAppScreensPath = path.join(
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
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");

describe("E2E navigation compact surface contract", () => {
  it("keeps the default page and assertion routes compact", async () => {
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppScreensSource = await fs.readFile(e2eAppScreensPath, "utf8");
    const e2eAppScreenTestIDsSource = await fs.readFile(
      e2eAppScreenTestIDsPath,
      "utf8",
    );

    expect(e2eAppRoutesSource).toContain('Ready: "e2e/ready"');
    expect(e2eAppRoutesSource).toContain('RuntimeBundle: "e2e/runtime-bundle"');
    expect(e2eAppRoutesSource).toContain('RuntimeMarker: "e2e/runtime-marker"');
    expect(e2eAppRoutesSource).toContain(
      'RuntimeLargeAsset: "e2e/runtime-large-asset"',
    );
    expect(e2eAppRoutesSource).toContain(
      'LaunchCrashedBundle: "e2e/launch-crashed-bundle"',
    );
    expect(e2eAppRoutesSource).toContain(
      'ChannelActionResult: "e2e/channel-action-result"',
    );
    expect(e2eAppRoutesSource).toContain(
      'UpdateActionResult: "e2e/update-action-result"',
    );
    expect(e2eAppRoutesSource).toContain(
      'CohortActionResult: "e2e/cohort-action-result"',
    );
    expect(e2eAppIndexSource).not.toContain("RuntimeIdentity");
    expect(e2eAppIndexSource).not.toContain("ActionResults");
    expect(e2eAppScreensSource).not.toContain("RuntimeIdentityScreen");
    expect(e2eAppScreensSource).not.toContain("ActionResultsScreen");
    expect(e2eAppScreenTestIDsSource).toContain('Ready: "e2e-screen-ready"');
    expect(e2eAppScreenTestIDsSource).not.toContain("ScrollView");
  });

  it("keeps action and multi-value assertions on one-target routes", async () => {
    const e2eAppRoutesSource = await fs.readFile(e2eAppRoutesPath, "utf8");
    const e2eAppScreensSource = await fs.readFile(e2eAppScreensPath, "utf8");
    const e2eAppScreenTestIDsSource = await fs.readFile(
      e2eAppScreenTestIDsPath,
      "utf8",
    );
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");

    expect(e2eAppRoutesSource).not.toContain("InstallActions");
    expect(e2eAppRoutesSource).not.toContain("RuntimeChannelActions");
    expect(e2eAppRoutesSource).not.toContain("CohortInputActions");
    expect(e2eAppRoutesSource).not.toContain("CohortPresetActions");
    expect(e2eAppRoutesSource).not.toContain("RuntimeState");
    expect(e2eAppRoutesSource).not.toContain("UpdateStore:");
    expect(e2eAppScreensSource).not.toContain("InstallActionsScreen");
    expect(e2eAppScreensSource).not.toContain("RuntimeChannelActionsScreen");
    expect(e2eAppScreensSource).not.toContain("CohortInputActionsScreen");
    expect(e2eAppScreensSource).not.toContain("CohortPresetActionsScreen");
    expect(e2eAppScreensSource).not.toContain("RuntimeStateScreen");
    expect(e2eAppScreensSource).not.toContain("UpdateStoreScreen");

    for (const path of [
      "e2e/action/refresh-runtime-snapshot",
      "e2e/action/reload-app",
      "e2e/action/clear-crash-history",
      "e2e/action/install-current-channel-update",
      "e2e/input/runtime-channel",
      "e2e/action/install-runtime-channel-update",
      "e2e/action/reset-runtime-channel",
      "e2e/input/cohort",
      "e2e/action/apply-cohort-input",
      "e2e/action/set-cohort-qa",
      "e2e/action/restore-initial-cohort",
      "e2e/runtime-channel-summary",
      "e2e/runtime-cohort-summary",
      "e2e/update-store-downloaded",
      "e2e/update-store-download-paths",
    ]) {
      expect(e2eAppRoutesSource).toContain(path);
      expect(detoxPageSource).toContain(`hotupdaterexample://${path}`);
    }

    expect(e2eAppScreenTestIDsSource).toContain(
      "RefreshRuntimeSnapshotAction:",
    );
    expect(e2eAppScreenTestIDsSource).toContain(
      '"e2e-screen-action-refresh-runtime-snapshot"',
    );
    expect(e2eAppScreenTestIDsSource).toContain("UpdateStoreDownloadPaths:");
    expect(e2eAppScreenTestIDsSource).toContain(
      '"e2e-screen-update-store-download-paths"',
    );
    expect(detoxPageSource).not.toContain("installActions");
    expect(detoxPageSource).not.toContain("runtimeChannelActions");
    expect(detoxPageSource).not.toContain("cohortInputActions");
    expect(detoxPageSource).not.toContain("runtimeState");
    expect(detoxPageSource).not.toContain("updateStore:");
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

    expect(readyScreenBody).toContain('current="Ready"');
    expect(readyScreenBody).not.toContain("RuntimeBundleScreen");
    expect(readyScreenBody).not.toContain("RuntimeMarkerScreen");
    expect(readyScreenBody).not.toContain("ActionScreen");
    expect(readyScreenBody).not.toContain("InfoRow");
    expect(readyScreenBody).not.toContain("Button");
  });

  it("keeps the app entrypoint from becoming a scenario screen registry", async () => {
    const e2eAppIndexSource = await fs.readFile(e2eAppIndexPath, "utf8");

    expect(e2eAppIndexSource).toContain("E2eStack");
    expect(e2eAppIndexSource).not.toContain("Stack.Navigator");
    expect(e2eAppIndexSource).not.toContain("Stack.Screen");
    expect(e2eAppIndexSource).not.toContain("e2e/action/");
    expect(e2eAppIndexSource).not.toContain("e2e/runtime-");
    expect(e2eAppIndexSource).not.toContain("RuntimeBundleScreen");
    expect(e2eAppIndexSource).not.toContain("InstallCurrentChannelUpdate");
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
});

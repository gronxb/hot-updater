import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(import.meta.dirname, "../..");
const e2eAppRoutePathsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/route-paths.ts",
);
const e2eAppScreenPathsDir = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screen-paths",
);
const e2eAppScreensIndexPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/index.ts",
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
const detoxScreenRoutesDir = path.join(repoDir, "e2e/detox/screen-routes");
const detoxAppDriverPath = path.join(repoDir, "e2e/detox/detox-app-driver.js");
const controlClientPath = path.join(repoDir, "e2e/detox/control-client.ts");
const controlServerControllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);
const controlServerRoutesPath = path.join(
  repoDir,
  "e2e/detox/control-server/routes.ts",
);
const controlServerScreenStatePath = path.join(
  repoDir,
  "e2e/detox/control-server/screen-state.ts",
);
const e2eRuntimeConfigPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eRuntimeConfig.ts",
);
const e2eRuntimeHookPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/useE2eRuntime.ts",
);
const e2eScreenStatePersistencePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screen-state-persistence.ts",
);

const collectSourceFiles = async (
  dir: string,
  extensions: readonly string[] = [".ts", ".tsx"],
): Promise<readonly string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(entryPath, extensions);
      if (extensions.includes(path.extname(entry.name))) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat();
};

const readSourceTree = async (
  dir: string,
  extensions?: readonly string[],
): Promise<string> => {
  const sourceFiles = await collectSourceFiles(dir, extensions);
  const sources = await Promise.all(
    sourceFiles.map((filePath) => fs.readFile(filePath, "utf8")),
  );
  return sources.join("\n");
};

describe("E2E navigation action route contract", () => {
  it("keeps action and multi-value assertions on one-target routes", async () => {
    const e2eAppRoutePathsSource = await fs.readFile(
      e2eAppRoutePathsPath,
      "utf8",
    );
    const e2eAppScreenPathsSource = await readSourceTree(e2eAppScreenPathsDir);
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await readSourceTree(detoxScreenRoutesDir, [
      ".js",
    ]);

    expect(e2eAppRoutePathsSource).not.toContain("InstallActions");
    expect(e2eAppRoutePathsSource).not.toContain("RuntimeChannelActions");
    expect(e2eAppRoutePathsSource).not.toContain("CohortInputActions");
    expect(e2eAppRoutePathsSource).not.toContain("CohortPresetActions");
    expect(e2eAppRoutePathsSource).not.toContain("RuntimeState");
    expect(e2eAppRoutePathsSource).not.toContain("RuntimeChannelSummary");
    expect(e2eAppRoutePathsSource).not.toContain("RuntimeCohortSummary");
    expect(e2eAppRoutePathsSource).not.toContain("CrashHistory:");
    expect(e2eAppRoutePathsSource).not.toContain("UpdateStore:");
    await expect(fs.stat(e2eAppScreensIndexPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

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
      "e2e/runtime-current-channel",
      "e2e/runtime-default-channel",
      "e2e/runtime-channel-switched",
      "e2e/runtime-current-cohort",
      "e2e/runtime-initial-cohort",
      "e2e/crash-history-count",
      "e2e/update-store-downloaded",
      "e2e/update-store-download-paths",
    ]) {
      expect(e2eAppScreenPathsSource).toContain(path);
      expect(detoxScreenRoutesSource).toContain(`hotupdaterexample://${path}`);
    }

    expect(detoxScreenRoutesSource).toContain(
      '"action-refresh-runtime-snapshot": "refreshRuntimeSnapshotAction"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"update-store-download-paths": "updateStoreDownloadPaths"',
    );
    expect(detoxPageSource).not.toContain("installActions");
    expect(detoxPageSource).not.toContain("runtimeChannelActions");
    expect(detoxPageSource).not.toContain("cohortInputActions");
    expect(detoxPageSource).not.toContain("runtimeState");
    expect(detoxPageSource).not.toContain("updateStore:");
    expect(detoxPageSource).not.toContain('by.id("e2e-screen-content")');
    expect(detoxPageSource).not.toContain("e2e-screen-content");
  });

  it("keeps stateful workflow inputs separate from compact action result routes", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await readSourceTree(detoxScreenRoutesDir, [
      ".js",
    ]);
    const cohortInputScreenSource = await fs.readFile(
      path.join(e2eAppScreensDir, "cohort-input-screen.tsx"),
      "utf8",
    );
    const runtimeChannelInputScreenSource = await fs.readFile(
      path.join(e2eAppScreensDir, "runtime-channel-input-screen.tsx"),
      "utf8",
    );
    const applyCohortActionScreenSource = await fs.readFile(
      path.join(e2eAppScreensDir, "apply-cohort-input-action-screen.tsx"),
      "utf8",
    );
    const installRuntimeActionScreenSource = await fs.readFile(
      path.join(
        e2eAppScreensDir,
        "install-runtime-channel-update-action-screen.tsx",
      ),
      "utf8",
    );

    expect(detoxScreenRoutesSource).toContain(
      '"action-apply-cohort-input": "applyCohortInputAction"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"action-set-cohort-qa": "setCohortQaAction"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"action-restore-initial-cohort": "restoreInitialCohortAction"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"cohort-action-result": "cohortActionResult"',
    );
    expect(detoxScreenRoutesSource).toMatch(
      /"action-install-runtime-channel-update":\s*"installRuntimeChannelUpdateAction"/,
    );
    expect(detoxScreenRoutesSource).toContain(
      '"action-reset-runtime-channel": "resetRuntimeChannelAction"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"channel-action-result": "channelActionResult"',
    );
    expect(cohortInputScreenSource).toContain('testID="cohort-input"');
    expect(cohortInputScreenSource).not.toContain('testID="action-');
    expect(runtimeChannelInputScreenSource).toContain(
      'testID="runtime-channel-input"',
    );
    expect(runtimeChannelInputScreenSource).not.toContain('testID="action-');
    expect(applyCohortActionScreenSource).toContain(
      'testID="action-apply-cohort-input"',
    );
    expect(applyCohortActionScreenSource).not.toContain(
      'testID="cohort-action-result"',
    );
    expect(installRuntimeActionScreenSource).toContain(
      'testID="action-install-runtime-channel-update"',
    );
    expect(installRuntimeActionScreenSource).not.toContain(
      'testID="channel-action-result"',
    );
    expect(detoxScreenRoutesSource).not.toContain(
      "function resultTestIDForActionTestID(testID)",
    );
    expect(detoxPageSource).toContain("activeScreenPath");
    expect(detoxPageSource).not.toContain("activeResultScreenPaths");
  });

  it("keeps action pages and result pages as distinct one-target routes", async () => {
    const screenFiles = (await fs.readdir(e2eAppScreensDir)).filter(
      (fileName) => fileName.endsWith(".tsx"),
    );

    for (const fileName of screenFiles) {
      const source = await fs.readFile(
        path.join(e2eAppScreensDir, fileName),
        "utf8",
      );
      const actionTestIDs = source.match(/testID="action-[^"]+"/g) ?? [];
      const resultTestIDs = source.match(/testID="[^"]+-action-result"/g) ?? [];

      expect(
        actionTestIDs.length === 0 || resultTestIDs.length === 0,
        fileName,
      ).toBe(true);
    }

    const detoxAppDriverSource = await fs.readFile(detoxAppDriverPath, "utf8");
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );

    expect(detoxAppDriverSource).not.toContain(
      "rememberActionResultScreenPath",
    );
    expect(detoxPageSource).not.toContain("activeResultScreenPaths");
    expect(detoxScreenRoutesSource).not.toContain("ACTION_RESULT_TEST_IDS");
  });

  it("persists action route state across Android deep-link remounts", async () => {
    const controlServerControllerSource = await fs.readFile(
      controlServerControllerPath,
      "utf8",
    );
    const controlServerRoutesSource = await fs.readFile(
      controlServerRoutesPath,
      "utf8",
    );
    const controlServerScreenStateSource = await fs.readFile(
      controlServerScreenStatePath,
      "utf8",
    );
    const detoxAppDriverSource = await fs.readFile(detoxAppDriverPath, "utf8");
    const e2eRuntimeConfigSource = await fs.readFile(
      e2eRuntimeConfigPath,
      "utf8",
    );
    const e2eRuntimeHookSource = await fs.readFile(e2eRuntimeHookPath, "utf8");
    const e2eScreenStatePersistenceSource = await fs.readFile(
      e2eScreenStatePersistencePath,
      "utf8",
    );

    expect(e2eRuntimeHookSource).not.toContain("const e2eRuntimeMemory");
    expect(controlServerControllerSource).toContain("screenState");
    expect(controlServerControllerSource).toContain("resetE2eScreenState");
    expect(controlServerScreenStateSource).toContain("screenState");
    expect(controlServerScreenStateSource).toContain(
      "handlePatchE2eScreenState",
    );
    expect(controlServerScreenStateSource).toContain("resetE2eScreenState");
    expect(controlServerRoutesSource).toContain("/e2e/screen-state");
    expect(controlServerRoutesSource).toContain("handlePatchE2eScreenState");
    expect(detoxAppDriverSource).toContain("patchScreenStateForTextInput");
    expect(detoxAppDriverSource).toContain('"cohort-input"');
    expect(detoxAppDriverSource).toContain('"runtime-channel-input"');
    expect(e2eRuntimeConfigSource).toContain("readE2eScreenState");
    expect(e2eRuntimeConfigSource).toContain("patchE2eScreenState");
    expect(e2eRuntimeConfigSource).not.toContain('new URL("screen-state"');
    expect(e2eRuntimeConfigSource).toContain(
      'replace(/\\/runtime-config$/, "/screen-state")',
    );
    expect(e2eRuntimeHookSource).toContain("readPersistedScreenState");
    expect(e2eRuntimeHookSource).toContain("persistScreenState");
    expect(e2eScreenStatePersistenceSource).toContain("readE2eScreenState");
    expect(e2eScreenStatePersistenceSource).toContain("patchE2eScreenState");
    expect(e2eRuntimeHookSource).toMatch(
      /await\s+setUpdateActionResult\(\s*`\$\{actionLabel\} -> checking`/s,
    );
    expect(e2eRuntimeHookSource).toMatch(
      /await\s+setChannelActionResult\(\s*`runtime-channel -> \$\{normalizedChannel\}`/s,
    );
    expect(e2eRuntimeHookSource).toMatch(
      /await\s+setCohortActionResult\(\s*`set -> \$\{appliedCohort\}`/s,
    );
  });

  it("waits for published action results before result-route assertions", async () => {
    const detoxAppDriverSource = await fs.readFile(detoxAppDriverPath, "utf8");
    const controlClientSource = await fs.readFile(controlClientPath, "utf8");

    expect(detoxAppDriverSource).toContain("ACTION_RESULT_FIELDS");
    expect(detoxAppDriverSource).toContain(
      '"action-install-current-channel-update": "updateActionResult"',
    );
    expect(detoxAppDriverSource).toContain(
      '"action-install-runtime-channel-update": "updateActionResult"',
    );
    expect(detoxAppDriverSource).toContain(
      '"action-reset-runtime-channel": "channelActionResult"',
    );
    expect(detoxAppDriverSource).toContain(
      '"action-apply-cohort-input": "cohortActionResult"',
    );
    expect(detoxAppDriverSource).toContain(
      "await this.waitForActionResultAfterTap(stage, testID);",
    );
    expect(detoxAppDriverSource).toContain("waitForScreenStateField");
    expect(controlClientSource).toContain("waitForScreenStateField");
    expect(controlClientSource).toContain("/e2e/runtime-config");
    expect(controlClientSource).not.toMatch(/\bretry\b/i);
    expect(detoxAppDriverSource).not.toMatch(/\bretry\b/i);
    expect(detoxAppDriverSource).not.toMatch(/\bsetTimeout\b/i);
  });
});

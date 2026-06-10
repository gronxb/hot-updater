import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "./control-client.ts";
import {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
  resolveDetoxSuiteScenarioNames,
} from "./scenarios.ts";
import type { DetoxControlOptions, DetoxAppDriver } from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxRunnerPath = path.join(repoDir, "e2e/detox/scripts/run.ts");
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");
const detoxScreenRoutesPath = path.join(
  repoDir,
  "e2e/detox/detox-screen-routes.js",
);
const detoxJestSpecPath = path.join(repoDir, "e2e/detox/scenarios.spec.js");
const detoxScenarioRuntimePath = path.join(
  repoDir,
  "e2e/detox/detox-app-driver.js",
);
const detoxControlServerControllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);
const scenarioDir = path.join(repoDir, "e2e/detox/scenarios");
const exampleAppPath = path.join(repoDir, "examples/v0.85.0/App.tsx");
const exampleE2eAppPatchSurfacePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/patchSurface.ts",
);
const exampleE2eAppRuntimePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/runtime.ts",
);
const exampleE2eAppComponentsPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/components.tsx",
);
const exampleE2eAppActionButtonScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/action-button-screen.tsx",
);
const exampleE2eAppInstallCurrentScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/install-current-channel-update-action-screen.tsx",
);
const exampleE2eAppInstallRuntimeScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/install-runtime-channel-update-action-screen.tsx",
);
const exampleE2eAppApplyCohortInputScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/apply-cohort-input-action-screen.tsx",
);
const exampleE2eAppSetCohortQaScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/set-cohort-qa-action-screen.tsx",
);
const exampleE2eAppRestoreInitialCohortScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/restore-initial-cohort-action-screen.tsx",
);
const exampleE2eAppResetRuntimeChannelScreenPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/screens/reset-runtime-channel-action-screen.tsx",
);
const exampleE2eAppUseRuntimePath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eApp/useE2eRuntime.ts",
);
const exampleE2eAppResultScreenPaths = [
  "examples/v0.85.0/src/e2eApp/screens/channel-action-result-screen.tsx",
  "examples/v0.85.0/src/e2eApp/screens/update-action-result-screen.tsx",
  "examples/v0.85.0/src/e2eApp/screens/cohort-action-result-screen.tsx",
].map((screenPath) => path.join(repoDir, screenPath));
const runtimeConfigPath = path.join(
  repoDir,
  "examples/v0.85.0/src/e2eRuntimeConfig.ts",
);
const defaultDetoxScenarioNames = [
  "release-ota-recovery",
  "multi-asset-replacement",
  "bspatch-archive-to-diff-ota",
  "bspatch-consecutive-diff-ota",
  "bspatch-disabled-chain-rollback",
  "bspatch-manifest-diff-fallback",
  "runtime-channel-switch-reset",
  "numeric-cohort-rollout",
  "target-cohorts-only",
  "target-cohorts-rollout-interaction",
  "targeted-cohort-switchback",
  "force-update-auto-reload",
  "disabled-bundle-rollback-to-builtin",
  "disabled-bundle-rollback-to-previous-ota",
] as const;

type RecordedScenarioCall =
  | {
      readonly contains: string;
      readonly kind: "assertText";
      readonly options?: DetoxAssertTextOptions;
      readonly stage: string;
      readonly testID: string;
    }
  | {
      readonly body?: JsonObject;
      readonly kind: "control";
      readonly options?: DetoxControlOptions;
      readonly pathName: string;
      readonly stage: string;
    }
  | {
      readonly kind:
        | "launch"
        | "reload"
        | "resetAppState"
        | "tap"
        | "terminate"
        | "typeText";
      readonly stage: string;
      readonly testID?: string;
    };

async function recordScenarioCalls(
  scenarioName: string,
): Promise<readonly RecordedScenarioCall[]> {
  const calls: RecordedScenarioCall[] = [];
  const app: DetoxAppDriver = {
    assertText: (stage, testID, contains, options) => {
      calls.push({ contains, kind: "assertText", options, stage, testID });
      return Promise.resolve();
    },
    control: (stage, pathName, body, options) => {
      calls.push({ body, kind: "control", options, pathName, stage });
      return Promise.resolve();
    },
    launch: (stage) => {
      calls.push({ kind: "launch", stage });
      return Promise.resolve();
    },
    reload: (stage) => {
      calls.push({ kind: "reload", stage });
      return Promise.resolve();
    },
    resetAppState: (stage) => {
      calls.push({ kind: "resetAppState", stage });
      return Promise.resolve();
    },
    tap: (stage, testID) => {
      calls.push({ kind: "tap", stage, testID });
      return Promise.resolve();
    },
    terminate: (stage) => {
      calls.push({ kind: "terminate", stage });
      return Promise.resolve();
    },
    typeText: (stage, testID) => {
      calls.push({ kind: "typeText", stage, testID });
      return Promise.resolve();
    },
  };
  await getDetoxScenarioDefinition(scenarioName).run(app);
  return calls;
}

async function readDetoxRuntimeSource(): Promise<string> {
  return (
    await Promise.all(
      [detoxJestSpecPath, detoxPagePath, detoxScenarioRuntimePath].map((file) =>
        fs.readFile(file, "utf8"),
      ),
    )
  ).join("\n");
}

async function scenarioStages(
  scenarioName: string,
): Promise<readonly string[]> {
  return (await recordScenarioCalls(scenarioName)).map((call) => call.stage);
}

async function updateActionResultAssertStages(
  scenarioName: string,
): Promise<readonly string[]> {
  return (await recordScenarioCalls(scenarioName))
    .filter(
      (call) =>
        call.kind === "assertText" && call.testID === "update-action-result",
    )
    .map((call) => call.stage);
}

async function controlStepBody(
  scenarioName: string,
  stage: string,
): Promise<JsonObject> {
  const call = (await recordScenarioCalls(scenarioName)).find(
    (entry) => entry.stage === stage,
  );
  if (!call || call.kind !== "control") {
    throw new Error(`Missing control step ${stage} in ${scenarioName}`);
  }
  return call.body ?? {};
}

async function controlStepDefinition(
  scenarioName: string,
  stage: string,
): Promise<Extract<RecordedScenarioCall, { readonly kind: "control" }>> {
  const call = (await recordScenarioCalls(scenarioName)).find(
    (entry) => entry.stage === stage,
  );
  if (!call || call.kind !== "control") {
    throw new Error(`Missing control step ${stage} in ${scenarioName}`);
  }
  return call;
}

describe("Detox scenario contract", () => {
  it("defines the default suite from Detox-owned catalog modules", () => {
    const detoxScenarios = resolveDetoxSuiteScenarioNames("default");

    expect(detoxScenarios).toEqual(defaultDetoxScenarioNames);
    expect(listDetoxScenarioNames()).toEqual(defaultDetoxScenarioNames);
    expect(new Set(listDetoxScenarioNames()).size).toBe(14);
  });

  it("uses Detox-owned scenario lookup in the runner", async () => {
    // Given: the CLI must run the Detox suite.
    const runnerSource = await fs.readFile(detoxRunnerPath, "utf8");

    // When: the runner resolves scenario names from the Detox catalog.
    expect(runnerSource).toContain("resolveDetoxSuiteScenarioNames");
    expect(runnerSource).toContain("listDetoxScenarioNames");
  });

  it("defines deterministic steps without sleep or retry wrappers", async () => {
    // Given: Detox scenarios should expose hangs through stages, not time bumps.
    const files = await fs.readdir(scenarioDir);
    const sources = await Promise.all(
      files
        .filter((file) => file.endsWith(".ts"))
        .map((file) => fs.readFile(path.join(scenarioDir, file), "utf8")),
    );

    // When: the Detox scenario sources are inspected.
    const joinedSources = sources.join("\n");

    // Then: scenarios use testIDs and control stages without sleeps/retries.
    expect(joinedSources).toContain("action-install-current-channel-update");
    expect(joinedSources).toContain("cohort-input");
    expect(joinedSources).not.toMatch(/\bstages\s*:/);
    expect(joinedSources).not.toMatch(/\bsleep\b|\bsetTimeout\b|\bretry\b/i);
  });

  it("executes every Detox scenario through Detox-owned scenario functions", async () => {
    // Given: Detox CLI selects scenarios through Jest testNamePattern.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the Jest suite source is inspected.
    // Then: the suite discovers scenario names from the Detox catalog.
    expect(detoxJestSpec).toContain(
      "const scenarioNames = listDetoxScenarioNames();",
    );
    expect(detoxJestSpec).toContain("getDetoxScenarioDefinition");
    expect(detoxJestSpec).toContain("scenario.run(app)");
    expect(detoxJestSpec).not.toContain("step.kind");
    expect(detoxJestSpec).not.toContain(".todo");
  });

  it("emits a Jest testNamePattern that matches Detox full test names", async () => {
    const dryRunOutput = execFileSync(
      "pnpm",
      [
        "-w",
        "e2e:detox:ios",
        "--",
        "--scenario",
        "release-ota-recovery",
        "--dry-run",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
    );

    const pattern = dryRunOutput.match(/--testNamePattern '([^']+)'/)?.[1];

    expect(pattern).toBeDefined();
    expect(
      new RegExp(pattern ?? "").test(
        "HotUpdater Detox scenarios release-ota-recovery",
      ),
    ).toBe(true);
    expect(
      new RegExp(pattern ?? "").test(
        "HotUpdater Detox scenarios multi-asset-replacement",
      ),
    ).toBe(false);
  });

  it("resets remote bundles, app state, and Android host-port forwarding around each scenario", async () => {
    // Given: every scenario must start from clean remote, app, and network state.
    const detoxRuntimeSource = await readDetoxRuntimeSource();

    // When: the Detox Jest lifecycle is inspected.
    // Then: remote bundles, app state, and Android reverse TCP forwarding are cleaned per app.
    expect(detoxRuntimeSource).toContain("device.reverseTcpPort");
    expect(detoxRuntimeSource).toContain("device.unreverseTcpPort");
    expect(detoxRuntimeSource).toContain("HOT_UPDATER_E2E_CONTROL_PORT");
    expect(detoxRuntimeSource).toContain("HOT_UPDATER_SERVER_PORT");
    expect(detoxRuntimeSource).toContain(
      "for (const port of androidReversePorts())",
    );
    expect(detoxRuntimeSource).toContain("device.terminateApp");
    expect(detoxRuntimeSource).toContain("/e2e/jobs/reset-remote-bundles");
    expect(detoxRuntimeSource).toContain("/e2e/reset-local-app-state");
  });

  it("does not launch the app before provider bundles are deployed", async () => {
    // Given: the control server resets remote bundles and local app state
    // before any provider-backed update-check URL can be requested.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const beforeEachBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("beforeEach(async () =>"),
      detoxJestSpec.indexOf("\n  afterEach(async () =>"),
    );

    // When: Detox launches the app after reset.
    const bootstrapIndex = beforeEachBody.indexOf("/e2e/jobs/bootstrap");
    const resetRemoteIndex = beforeEachBody.indexOf(
      "/e2e/jobs/reset-remote-bundles",
    );
    const resetLocalIndex = beforeEachBody.indexOf(
      "/e2e/reset-local-app-state",
    );
    const launchIndex = beforeEachBody.indexOf("launchApp");

    // Then: a scenario must decide when to launch, after it has deployed the
    // first provider bundle. Launching here can cache empty CDN responses.
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(resetRemoteIndex).toBeGreaterThan(bootstrapIndex);
    expect(resetLocalIndex).toBeGreaterThan(resetRemoteIndex);
    expect(launchIndex).toBe(-1);
    expect(beforeEachBody).not.toContain("delete: true");
  });

  it("launches scenarios only after the first deploy-bundle step", async () => {
    const baselineBeforeDeployScenarios = new Set<string>([
      "bspatch-disabled-chain-rollback",
      "disabled-bundle-rollback-to-builtin",
      "disabled-bundle-rollback-to-previous-ota",
      "runtime-channel-switch-reset",
    ]);

    for (const scenarioName of defaultDetoxScenarioNames) {
      const calls = await recordScenarioCalls(scenarioName);
      const firstDeployIndex = calls.findIndex(
        (call) =>
          call.kind === "control" &&
          call.pathName === "/e2e/jobs/deploy-bundle",
      );
      const firstAppOpenIndex = calls.findIndex(
        (call) => call.kind === "launch" || call.kind === "reload",
      );
      const firstUiIndex = calls.findIndex(
        (call) =>
          call.kind === "assertText" ||
          call.kind === "tap" ||
          call.kind === "typeText",
      );

      expect(firstDeployIndex, scenarioName).toBeGreaterThan(-1);
      if (firstUiIndex === -1) {
        if (firstAppOpenIndex !== -1) {
          expect(firstAppOpenIndex, scenarioName).toBeGreaterThan(
            firstDeployIndex,
          );
        }
        continue;
      }
      if (baselineBeforeDeployScenarios.has(scenarioName)) {
        const preDeployCalls = calls.slice(0, firstDeployIndex);
        expect(
          preDeployCalls.some(
            (call) => call.kind === "launch" && call.stage.includes("built-in"),
          ),
          scenarioName,
        ).toBe(true);
        expect(
          preDeployCalls.every(
            (call) =>
              call.kind === "assertText" ||
              call.kind === "control" ||
              call.kind === "launch",
          ),
          scenarioName,
        ).toBe(true);
        continue;
      }
      expect(firstAppOpenIndex, scenarioName).toBeGreaterThan(firstDeployIndex);
      expect(firstUiIndex, scenarioName).toBeGreaterThan(firstAppOpenIndex);
    }
  });

  it("refreshes provider update-check state before installing each deployed bundle", async () => {
    for (const scenarioName of defaultDetoxScenarioNames) {
      const calls = await recordScenarioCalls(scenarioName);
      for (const [index, call] of calls.entries()) {
        if (
          call.kind !== "control" ||
          call.pathName !== "/e2e/jobs/deploy-bundle" ||
          !call.options?.saveResultAs
        ) {
          continue;
        }

        const nextDeployIndex = calls.findIndex(
          (nextCall, nextIndex) =>
            nextIndex > index &&
            nextCall.kind === "control" &&
            nextCall.pathName === "/e2e/jobs/deploy-bundle",
        );
        const installIndex = calls.findIndex(
          (nextCall, nextIndex) =>
            nextIndex > index &&
            (nextDeployIndex === -1 || nextIndex < nextDeployIndex) &&
            nextCall.kind === "tap" &&
            nextCall.testID === "action-install-current-channel-update",
        );
        if (installIndex === -1) {
          continue;
        }

        const refreshIndex = calls.findIndex(
          (nextCall, nextIndex) =>
            nextIndex > index &&
            nextIndex < installIndex &&
            (nextCall.kind === "launch" || nextCall.kind === "reload"),
        );
        expect(refreshIndex, `${scenarioName}: ${call.stage}`).toBeGreaterThan(
          index,
        );
      }
    }
  });

  it("captures the built-in bundle id with the minimum-id suffix contract", async () => {
    // Given: HotUpdater.getBundleId() can expose a platform-generated UUID
    // with the built-in minimum id suffix.
    const controllerSource = await fs.readFile(
      path.join(repoDir, "e2e/detox/control-server/controller.ts"),
      "utf8",
    );

    // When: scenarios capture the built-in bundle id for later UI assertions.
    // Then: Detox must preserve the minimum-id suffix contract instead of requiring
    // a hard-coded full UUID that iOS does not expose.
    expect(controllerSource).toContain(
      "const builtInBundleId = BUILT_IN_MIN_BUNDLE_ID_SUFFIX;",
    );
    expect(controllerSource).not.toContain(
      "const builtInBundleId = E2E_MIN_BUNDLE_ID;",
    );
  });

  it("seeds Detox scenario values from the bootstrap contract", async () => {
    // Given: Maestro exposes bootstrap outputs like output.initialMarker to every
    // scenario step.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );

    // When: Detox creates a per-scenario driver after bootstrap.
    // Then: the driver must start with bootstrap values so $initialMarker
    // placeholder assertions match the Maestro baseline.
    expect(detoxJestSpec).toContain("bootstrapResult = await");
    expect(detoxJestSpec).toContain(
      "new DetoxAppDriver(controlClient, bootstrapResult)",
    );
    expect(detoxRuntimeSource).toContain("constructor(client, initialValues");
  });

  it("uses the checked-in native built-in marker for bootstrap assertions", async () => {
    // Given: provider jobs reuse the native app built during shared setup.
    const patchSurfaceSource = await fs.readFile(
      exampleE2eAppPatchSurfacePath,
      "utf8",
    );
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const nativeMarker = patchSurfaceSource.match(
      /export const E2E_SCENARIO_MARKER = "([^"]+)";/,
    )?.[1];

    // When: Detox seeds Maestro-compatible output.initialMarker.
    // Then: the seeded marker must match the actual built-in app default,
    // because Detox-first lifecycle does not reinstall a patched built-in app
    // from the fixture server.
    expect(nativeMarker).toBe("targeted-qa-detox");
    expect(controllerSource).toContain(
      `const BUILT_IN_APP_MARKER = "${nativeMarker}";`,
    );
    expect(controllerSource).toContain("initialMarker: BUILT_IN_APP_MARKER");
    expect(controllerSource).not.toContain('"builtin-ios-detox"');
    expect(controllerSource).not.toContain('"builtin-android-detox"');
  });

  it("passes runtime config through Detox launch arguments", async () => {
    // Given: split provider jobs assign a per-shard runtime config URL at test
    // runtime, after the native app has already been built.
    const detoxRuntimeSource = await readDetoxRuntimeSource();

    // When: Detox launches or reattaches the app.
    // Then: every launch goes through launchArgs instead of relying on @env.
    expect(detoxRuntimeSource).toContain("function runtimeLaunchArgs()");
    expect(detoxRuntimeSource).toContain("HOT_UPDATER_E2E_RUNTIME_CONFIG_URL");
    expect(detoxRuntimeSource).toContain("launchArgs: runtimeLaunchArgs()");
    expect(detoxRuntimeSource).not.toContain(
      "device.launchApp({ newInstance: true })",
    );
    expect(detoxRuntimeSource).not.toContain(
      "device.launchApp({ newInstance: false })",
    );
  });

  it("reattaches instead of cold-launching Android when the target app is already focused", async () => {
    // Given: Android provider jobs can enter a launch stage while the target app
    // is already foregrounded and Detox-connected.
    const detoxRuntimeSource = await readDetoxRuntimeSource();
    const controllerSource = await fs.readFile(
      path.join(repoDir, "e2e/detox/control-server/controller.ts"),
      "utf8",
    );
    const launchBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async launch(stage)"),
      detoxRuntimeSource.indexOf("async reload(stage)"),
    );
    const prepareBody = controllerSource.slice(
      controllerSource.indexOf("async function prepareAppLaunch()"),
      controllerSource.indexOf("async function bootstrap()"),
    );

    // When: the control server reports that focusedPackage matches targetAppId.
    // Then: the Detox driver must reattach through Detox APIs instead of forcing
    // a fresh Android app instance, and the control server must not force-stop an
    // already-focused target app before Detox reconnects.
    expect(prepareBody).toContain("alreadyFocused");
    expect(prepareBody).toContain("focusedPackage === fixtureSession.appId");
    expect(prepareBody).toContain("if (!alreadyFocused) {");
    expect(launchBody).toContain("const launchState =");
    expect(launchBody).toContain("launchState.alreadyFocused");
    expect(launchBody).toContain("isAndroidRun()");
    expect(launchBody).toContain("newInstance: false");
    expect(launchBody).toContain("newInstance: true");
    expect(launchBody).not.toMatch(/\bretry\b/i);
    expect(launchBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps Detox runtime config wiring outside App.tsx", async () => {
    // Given: provider-specific URLs must remain runtime values so native builds
    // can be reused across profiles and shards without bloating App.tsx.
    const exampleAppSource = await fs.readFile(exampleAppPath, "utf8");
    const e2eRuntimeSource = await fs.readFile(
      exampleE2eAppRuntimePath,
      "utf8",
    );
    const runtimeConfigSource = await fs.readFile(runtimeConfigPath, "utf8");

    // When: the example app wires HotUpdater.
    // Then: App.tsx imports a runtime helper and the helper gives Detox launch
    // arguments precedence over react-native-dotenv.
    const launchArgumentsIndex = runtimeConfigSource.indexOf(
      "LaunchArguments.value",
    );
    const runtimeConfigIndex = runtimeConfigSource.indexOf(
      "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL || DEFAULT_E2E_RUNTIME_CONFIG_URL",
    );

    expect(exampleAppSource).toContain("./src/e2eApp");
    expect(e2eRuntimeSource).toContain("../e2eRuntimeConfig");
    expect(exampleAppSource).not.toContain("react-native-launch-arguments");
    expect(exampleAppSource).not.toContain('from "@env"');
    expect(runtimeConfigSource).toContain("react-native-launch-arguments");
    expect(launchArgumentsIndex).toBeGreaterThan(-1);
    expect(runtimeConfigIndex).toBe(-1);
    expect(runtimeConfigSource).toContain("detoxLaunchArgumentString");
    expect(runtimeConfigSource).not.toContain(
      "const runtimeConfigURL =\n  HOT_UPDATER_E2E_RUNTIME_CONFIG_URL || DEFAULT_E2E_RUNTIME_CONFIG_URL;",
    );
  });

  it("keeps interaction foregrounding inside Detox APIs", async () => {
    // Given: the foreground helper runs before every Detox UI assertion.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const foregroundBody = detoxPageSource.slice(
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
      detoxPageSource.indexOf("async function findVisibleTestID"),
    );

    // When: the helper foregrounds the app.
    // Then: only Android uses a Detox relaunch; the control server does not
    // run an out-of-band recovery ladder before each interaction.
    expect(foregroundBody).not.toContain("/e2e/ensure-app-foreground");
    expect(foregroundBody).not.toContain("device.sendToHome()");
    expect(foregroundBody).toContain("if (isAndroidRun())");
    expect(foregroundBody).toContain(
      "await launchApp({ newInstance: false });",
    );
    expect(foregroundBody).not.toMatch(
      /\}\s*await launchApp\(\{ newInstance: false \}\);/,
    );
    expect(foregroundBody).not.toMatch(/\bretry\b/i);
    expect(foregroundBody).not.toContain("device.terminateApp");
    expect(detoxRuntimeSource).toContain("text.includes(expectedText)");
  });

  it("lets scenario result assertions prove action taps without a start-count UI", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(tapBody).toContain("await target.tap()");
    expect(tapBody).not.toContain("waitForActionStartCount");
    expect(detoxRuntimeSource).not.toContain("async waitForActionStartCount(");
    expect(detoxRuntimeSource).not.toContain("readActionStartCount(testID)");
    expect(detoxRuntimeSource).not.toContain("Action Start Count:");
    expect(detoxRuntimeSource).not.toContain("metadata.json");
    expect(tapBody).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("reattaches Android Detox only after app-action reload taps", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );
    const reattachBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async reattachAfterExternalLaunch"),
      detoxRuntimeSource.indexOf("module.exports"),
    );

    expect(tapBody).not.toContain("isInstallAction");
    expect(tapBody).not.toContain("reattachAfterInstallTap");
    expect(tapBody).toContain(
      'const isAppReloadAction = testID === "action-reload-app";',
    );
    expect(tapBody).toContain(
      "await this.reattachAfterAppReloadTap(isAppReloadAction);",
    );
    expect(reattachBody).not.toContain("async reattachAfterInstallTap(");
    expect(reattachBody).toContain("async reattachAfterAppReloadTap(");
    expect(reattachBody).toContain("await launchApp({ newInstance: false });");
    expect(reattachBody).not.toMatch(/\bretry\b/i);
    expect(reattachBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("waits for install action results before metadata/reset control probes", async () => {
    const metadataFirstInstallStages = new Set([
      "force-update-auto-reload: install force update",
      "multi-asset-replacement: install first multi-asset update",
      "multi-asset-replacement: install second multi-asset update",
      "release-ota-recovery: install stable update",
      "release-ota-recovery: install crash update",
      "runtime-channel-switch-reset: install runtime channel update",
      "bspatch-archive-to-diff-ota: install archive base update",
      "bspatch-archive-to-diff-ota: install archive diff update",
      "bspatch-consecutive-diff-ota: install diff bundle A",
      "bspatch-consecutive-diff-ota: install diff bundle B",
      "bspatch-consecutive-diff-ota: install diff bundle C",
      "bspatch-consecutive-diff-ota: install diff bundle D",
      "bspatch-disabled-chain-rollback: install chain bundle A",
      "bspatch-disabled-chain-rollback: install chain bundle B",
      "bspatch-disabled-chain-rollback: install chain bundle C",
      "bspatch-manifest-diff-fallback: install manifest base update",
      "bspatch-manifest-diff-fallback: install manifest fallback update",
      "targeted-cohort-switchback: install qa cohort update",
      "targeted-cohort-switchback: install numeric cohort rollback",
    ]);

    for (const scenarioName of defaultDetoxScenarioNames) {
      const calls = await recordScenarioCalls(scenarioName);
      const installTapIndexes = calls
        .map((call, index) => ({ call, index }))
        .filter(
          ({ call }) =>
            call.kind === "tap" && call.testID?.startsWith("action-install-"),
        );

      for (const { index } of installTapIndexes) {
        const stageLabel = `${scenarioName}: ${
          calls[index]?.stage ?? "missing install tap"
        }`;
        const nextControlIndex = calls.findIndex(
          (entry, nextIndex) =>
            nextIndex > index &&
            entry.kind === "control" &&
            (entry.pathName === "/e2e/jobs/wait-for-metadata" ||
              entry.pathName === "/e2e/assert-metadata-reset"),
        );

        expect(nextControlIndex, stageLabel).toBeGreaterThan(index);
        const exactActionResultAssertBeforeControl = calls
          .slice(index + 1, nextControlIndex)
          .some(
            (entry) =>
              entry.kind === "assertText" &&
              entry.testID === "update-action-result" &&
              entry.options?.exactText === true,
          );
        if (metadataFirstInstallStages.has(stageLabel)) {
          expect(exactActionResultAssertBeforeControl, stageLabel).toBe(false);
          continue;
        }

        expect(exactActionResultAssertBeforeControl, stageLabel).toBe(true);
      }
    }
  });

  it("keeps bsdiff and manifest flows on Detox action-route installs", async () => {
    const actionRouteScenarios = [
      "bspatch-archive-to-diff-ota",
      "bspatch-consecutive-diff-ota",
      "bspatch-disabled-chain-rollback",
      "bspatch-manifest-diff-fallback",
    ];

    for (const scenarioName of actionRouteScenarios) {
      const calls = await recordScenarioCalls(scenarioName);
      expect(
        calls.filter(
          (call) =>
            call.kind === "tap" &&
            call.testID === "action-install-current-channel-update",
        ),
      ).not.toEqual([]);
    }
  });

  it("keeps metadata waits on Maestro-equivalent relaunch behavior", async () => {
    const scenarioDirEntries = await fs.readdir(scenarioDir);
    const scenarioSources = await Promise.all(
      scenarioDirEntries
        .filter((entry) => entry.endsWith(".ts"))
        .map(async (entry) => ({
          entry,
          source: await fs.readFile(path.join(scenarioDir, entry), "utf8"),
        })),
    );

    expect(
      scenarioSources
        .filter(({ source }) => source.includes("relaunchLimit: 0"))
        .map(({ entry }) => entry),
    ).toEqual([]);
  });

  it("keeps install actions inline instead of routing through UI-start helpers", async () => {
    const scenarioDirEntries = await fs.readdir(scenarioDir);
    const scenarioSources = await Promise.all(
      scenarioDirEntries
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => fs.readFile(path.join(scenarioDir, entry), "utf8")),
    );

    expect(scenarioDirEntries).not.toContain("install-actions.ts");
    expect(scenarioSources.join("\n")).not.toContain(
      "installCurrentChannelUpdate",
    );
    expect(scenarioSources.join("\n")).not.toContain(
      "installRuntimeChannelUpdate",
    );
  });

  it("keeps Detox synchronization disabled until the app is relaunched after install actions", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const installTapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );
    const deviceActionBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async launch("),
      detoxRuntimeSource.indexOf("async tap(stage"),
    );
    const syncHelperBody = detoxPageSource.slice(
      detoxPageSource.indexOf(
        "async function disableSynchronizationUntilLaunch",
      ),
      detoxPageSource.indexOf(
        "async function withSynchronizationDisabledForPageOpen",
      ),
    );

    expect(installTapBody).toContain("disableSynchronizationUntilLaunch()");
    expect(syncHelperBody).toContain("device.disableSynchronization()");
    expect(syncHelperBody).toContain("synchronizationDisabledUntilLaunch");
    expect(installTapBody).not.toContain("waitForActionStartCount");
    expect(detoxRuntimeSource).not.toContain("findVisibleCurrentTestID");
    expect(detoxRuntimeSource).not.toContain("{ ensureForeground: false }");
    expect(installTapBody).not.toContain("device.enableSynchronization()");
    expect(installTapBody).not.toContain("finally");
    expect(deviceActionBody).toContain(
      "await launchApp({ newInstance: true })",
    );
    expect(installTapBody).not.toMatch(/\bretry\b/i);
    expect(installTapBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps install synchronization simple until the next app launch", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const syncHelperBody = detoxPageSource.slice(
      detoxPageSource.indexOf(
        "async function disableSynchronizationUntilLaunch",
      ),
      detoxPageSource.indexOf(
        "async function withSynchronizationDisabledForPageOpen",
      ),
    );

    expect(syncHelperBody).toContain(
      "if (synchronizationDisabledUntilLaunch) return;",
    );
    expect(syncHelperBody).not.toContain("options.force === true");
    expect(syncHelperBody).not.toContain("device.enableSynchronization()");
    expect(detoxRuntimeSource).not.toContain(
      "disableSynchronizationUntilLaunch({ force: true })",
    );
    expect(syncHelperBody).not.toMatch(/\bretry\b/i);
    expect(syncHelperBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("does not relaunch or reattach immediately after install taps", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const installTapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(installTapBody).not.toContain("isAndroidRun()");
    expect(installTapBody).not.toContain("isInstallAction");
    expect(installTapBody).not.toContain("reattachAfterInstallTap");
    expect(detoxRuntimeSource).not.toContain("async reattachAfterInstallTap");
    expect(installTapBody).not.toContain("waitForActionStartCount");
    expect(detoxRuntimeSource).not.toContain("async waitForActionStartCount");
    expect(installTapBody).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("starts install action button work during Detox tap dispatch", async () => {
    const componentsSource = await fs.readFile(
      exampleE2eAppComponentsPath,
      "utf8",
    );
    const actionButtonScreenSource = await fs.readFile(
      exampleE2eAppActionButtonScreenPath,
      "utf8",
    );
    const installCurrentScreenSource = await fs.readFile(
      exampleE2eAppInstallCurrentScreenPath,
      "utf8",
    );
    const installRuntimeScreenSource = await fs.readFile(
      exampleE2eAppInstallRuntimeScreenPath,
      "utf8",
    );
    const buttonBody = componentsSource.slice(
      componentsSource.indexOf("export const Button"),
      componentsSource.indexOf("export const ScreenShell"),
    );

    expect(buttonBody).not.toContain("readonly deferPress?: boolean");
    expect(buttonBody).not.toContain("deferredPressCount");
    expect(buttonBody).not.toContain("setDeferredPressCount");
    expect(buttonBody).toContain("void onPress();");
    expect(buttonBody).not.toContain("requestAnimationFrame");
    expect(buttonBody).not.toContain("setTimeout");
    expect(buttonBody).not.toContain("catch(() => undefined)");
    expect(actionButtonScreenSource).not.toContain("readonly deferPress");
    expect(actionButtonScreenSource).not.toContain("deferPress=");
    expect(installCurrentScreenSource).not.toContain("deferPress");
    expect(installRuntimeScreenSource).not.toContain("deferPress");
    expect(installCurrentScreenSource).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(installRuntimeScreenSource).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(componentsSource).not.toContain("ActionButtonWithStartCount");
    expect(componentsSource).not.toContain("-start-count");
  });

  it("publishes cohort action result before refreshing runtime state", async () => {
    const runtimeSource = await fs.readFile(
      exampleE2eAppUseRuntimePath,
      "utf8",
    );
    const applyCohortBody = runtimeSource.slice(
      runtimeSource.indexOf("const applyCohortValue = async"),
      runtimeSource.indexOf("const updateCohortInput"),
    );

    expect(applyCohortBody.indexOf("setCohortActionResult")).toBeLessThan(
      applyCohortBody.indexOf("await refresh()"),
    );
    expect(applyCohortBody).toContain("setCohortInput(appliedCohort)");
    expect(applyCohortBody).not.toMatch(/\bretry\b/i);
    expect(applyCohortBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("uses action result elements only for explicit assertions", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );
    const exampleResultScreenSource = (
      await Promise.all(
        exampleE2eAppResultScreenPaths.map((screenPath) =>
          fs.readFile(screenPath, "utf8"),
        ),
      )
    ).join("\n");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    expect(exampleResultScreenSource).toContain(
      'testID="update-action-result"',
    );
    expect(exampleResultScreenSource).not.toContain("update-action-start");
    expect(detoxScreenRoutesSource).toContain(
      'channelActionResult: "hotupdaterexample://e2e/channel-action-result"',
    );
    expect(detoxScreenRoutesSource).toContain(
      'updateActionResult: "hotupdaterexample://e2e/update-action-result"',
    );
    expect(detoxScreenRoutesSource).not.toContain("update-action-start");
    expect(detoxScreenRoutesSource).toContain(
      'cohortActionResult: "hotupdaterexample://e2e/cohort-action-result"',
    );
    expect(detoxPageSource).not.toContain('testID.endsWith("-result")');
    expect(detoxPageSource).not.toContain(
      'actionResults: "hotupdaterexample://e2e/results"',
    );
    expect(detoxPageSource).toContain(".toBeVisible()");
    expect(detoxRuntimeSource).not.toContain("async waitForActionStartCount");
    expect(assertTextBody).toContain("findVisibleTestID(");
    expect(assertTextBody).toContain("const target = await findVisibleTestID");
    expect(assertTextBody).toContain("await target.getAttributes()");
    expect(assertTextBody).toContain("textFromAttributes");
    expect(assertTextBody).toContain(".includes(expectedText)");
    expect(assertTextBody).not.toContain("waitForVisibleTestIDText");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps install action screens to the single focused action route", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const installCurrentScreenSource = await fs.readFile(
      exampleE2eAppInstallCurrentScreenPath,
      "utf8",
    );
    const installRuntimeScreenSource = await fs.readFile(
      exampleE2eAppInstallRuntimeScreenPath,
      "utf8",
    );
    expect(installCurrentScreenSource).toContain("FocusedActionRoute");
    expect(installRuntimeScreenSource).toContain("FocusedActionRoute");
    expect(installCurrentScreenSource).not.toContain("Button");
    expect(installRuntimeScreenSource).not.toContain("Button");
    expect(installCurrentScreenSource).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(installRuntimeScreenSource).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(detoxRuntimeSource).toContain(
      "await waitForCurrentTestIDText(testID, expectedText)",
    );
    expect(detoxRuntimeSource).not.toContain("Action Start Count:");
    expect(detoxRuntimeSource).not.toContain("openScreenForTestID(testID)");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps result-producing action screens to the single focused action route", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const actionScreenSources = await Promise.all([
      fs.readFile(exampleE2eAppApplyCohortInputScreenPath, "utf8"),
      fs.readFile(exampleE2eAppSetCohortQaScreenPath, "utf8"),
      fs.readFile(exampleE2eAppRestoreInitialCohortScreenPath, "utf8"),
      fs.readFile(exampleE2eAppResetRuntimeChannelScreenPath, "utf8"),
    ]);
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(actionScreenSources.join("\n")).toContain("FocusedActionRoute");
    expect(actionScreenSources.join("\n")).not.toContain("Button");
    expect(actionScreenSources.join("\n")).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(tapBody).not.toContain("waitForActionStartCount");
    expect(detoxRuntimeSource).not.toContain("shouldWaitForActionStartCount");
    expect(detoxRuntimeSource).toContain('"action-reload-app"');
    expect(detoxRuntimeSource).not.toContain("-start-count");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("starts result-producing actions from route focus without action-count UI", async () => {
    const componentsSource = await fs.readFile(
      exampleE2eAppComponentsPath,
      "utf8",
    );
    const focusedActionBody = componentsSource.slice(
      componentsSource.indexOf("export const FocusedActionRoute"),
      componentsSource.indexOf("export const ScreenShell"),
    );
    const resultActionScreenSources = (
      await Promise.all([
        fs.readFile(exampleE2eAppApplyCohortInputScreenPath, "utf8"),
        fs.readFile(exampleE2eAppSetCohortQaScreenPath, "utf8"),
        fs.readFile(exampleE2eAppRestoreInitialCohortScreenPath, "utf8"),
        fs.readFile(exampleE2eAppResetRuntimeChannelScreenPath, "utf8"),
        fs.readFile(exampleE2eAppInstallCurrentScreenPath, "utf8"),
        fs.readFile(exampleE2eAppInstallRuntimeScreenPath, "utf8"),
      ])
    ).join("\n");

    expect(focusedActionBody).toContain("useFocusEffect");
    expect(focusedActionBody).toContain("didRun.current = true;");
    expect(focusedActionBody).toContain("void onFocus();");
    expect(resultActionScreenSources).toContain("FocusedActionRoute");
    expect(resultActionScreenSources).not.toContain("PressInActionButton");
    expect(resultActionScreenSources).not.toContain(
      "ActionButtonWithStartCount",
    );
    expect(componentsSource).not.toContain("PressInActionButton");
    expect(componentsSource).not.toContain("ActionButtonWithStartCount");
    expect(componentsSource).not.toContain("setStartCount");
    expect(componentsSource).not.toContain("Action Start Count:");
  });

  it("runs result-producing actions from focused routes without Detox tapping Pressable", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const componentsSource = await fs.readFile(
      exampleE2eAppComponentsPath,
      "utf8",
    );
    const resultActionScreenSources = (
      await Promise.all([
        fs.readFile(exampleE2eAppApplyCohortInputScreenPath, "utf8"),
        fs.readFile(exampleE2eAppSetCohortQaScreenPath, "utf8"),
        fs.readFile(exampleE2eAppRestoreInitialCohortScreenPath, "utf8"),
        fs.readFile(exampleE2eAppResetRuntimeChannelScreenPath, "utf8"),
        fs.readFile(exampleE2eAppInstallCurrentScreenPath, "utf8"),
        fs.readFile(exampleE2eAppInstallRuntimeScreenPath, "utf8"),
      ])
    ).join("\n");
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );
    const routeActionBranch = tapBody.slice(
      tapBody.indexOf("const actionResultField"),
      tapBody.indexOf("const isAppReloadAction"),
    );

    expect(componentsSource).toContain("export const FocusedActionRoute");
    expect(componentsSource).not.toContain("PressInActionButton");
    expect(resultActionScreenSources).toContain("FocusedActionRoute");
    expect(resultActionScreenSources).not.toContain("PressInActionButton");
    expect(routeActionBranch).toContain(
      "await findVisibleTestID(this.controlClient, testID, {",
    );
    expect(routeActionBranch).toContain("alwaysOpen: true");
    expect(routeActionBranch).toContain(
      "await this.waitForActionResultField(stage, actionResultField);",
    );
    expect(routeActionBranch).not.toContain("target.tap()");
    expect(detoxRuntimeSource).not.toContain("PressInActionButton");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("resets focused action results before opening a repeatable action route", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );
    const routeActionBranch = tapBody.slice(
      tapBody.indexOf("const actionResultField"),
      tapBody.indexOf("const isAppReloadAction"),
    );

    expect(routeActionBranch).toContain(
      "await this.resetActionResultField(stage, actionResultField);",
    );
    expect(routeActionBranch.indexOf("resetActionResultField")).toBeLessThan(
      routeActionBranch.indexOf("findVisibleTestID"),
    );
    expect(detoxRuntimeSource).toContain("await this.controlClient.postJson(");
    expect(detoxRuntimeSource).toContain('"/e2e/screen-state"');
    expect(detoxRuntimeSource).toContain('[fieldName]: "idle"');
  });

  it("keeps explicit reloads at the cold-start boundary", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const reloadBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async reload(stage"),
      detoxRuntimeSource.indexOf("async resetAppState(stage"),
    );

    expect(reloadBody).not.toContain("disableSynchronizationUntilLaunch()");
    expect(reloadBody).toContain("await device.terminateApp()");
    expect(reloadBody).toContain('"/e2e/prepare-app-launch"');
    expect(reloadBody).toContain("await launchApp({ newInstance: true })");
    expect(reloadBody).not.toContain("device.enableSynchronization()");
    expect(reloadBody).not.toContain("finally");
    expect(reloadBody).not.toMatch(/\bretry\b/i);
    expect(reloadBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("prepares explicit reloads through the same control boundary as Maestro restart-app-home", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const reloadBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async reload(stage"),
      detoxRuntimeSource.indexOf("async resetAppState(stage"),
    );

    const prepareIndex = reloadBody.indexOf("/e2e/prepare-app-launch");
    const terminateIndex = reloadBody.indexOf("device.terminateApp()");
    const launchIndex = reloadBody.indexOf("launchApp({ newInstance: true })");

    expect(terminateIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(terminateIndex);
    expect(launchIndex).toBeGreaterThan(terminateIndex);
    expect(reloadBody).not.toMatch(/\bretry\b/i);
    expect(reloadBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("prefers the Detox control port over provider ports for host control traffic", async () => {
    // Given: dashboard split jobs set PORT/HOT_UPDATER_SERVER_PORT for the
    // provider update server and HOT_UPDATER_E2E_CONTROL_PORT for control.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");

    // When: the fallback control URL is inspected.
    const controlBaseUrlBody = detoxPageSource.slice(
      detoxPageSource.indexOf("function controlBaseUrl()"),
      detoxPageSource.indexOf("function runtimeLaunchArgs"),
    );
    const controlPortIndex = controlBaseUrlBody.indexOf(
      "process.env.HOT_UPDATER_E2E_CONTROL_PORT",
    );
    const serverPortIndex = controlBaseUrlBody.indexOf(
      "process.env.HOT_UPDATER_SERVER_PORT",
    );
    const providerPortIndex = controlBaseUrlBody.indexOf("process.env.PORT");

    // Then: a missing explicit CONTROL_URL cannot silently target the provider.
    expect(controlPortIndex).toBeGreaterThan(-1);
    expect(controlPortIndex).toBeLessThan(serverPortIndex);
    expect(controlPortIndex).toBeLessThan(providerPortIndex);
  });

  it("invalidates cached iOS bundle-store path when local state is reset", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const clearIosBody = controllerSource.slice(
      controllerSource.indexOf("async function clearIosLocalBundleState"),
      controllerSource.indexOf("function ensureAndroidFilesDir"),
    );

    expect(clearIosBody).toContain("fixtureSession.storePath = null");
    expect(clearIosBody).toContain("ios local bundle state reset");
  });

  it("keeps launch status assertions on dedicated screens", async () => {
    // Given: launch status and crashed-bundle status live on short screens.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );

    // Then: both assertions avoid the generic action result route.
    expect(detoxScreenRoutesSource).toContain(
      '"launch-status-result": "launchStatus"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"launch-crashed-bundle-result": "launchCrashedBundle"',
    );
    expect(detoxPageSource).not.toContain('testID.endsWith("-result")');
  });

  it("routes action inputs to target-specific screens before runtime assertions", async () => {
    // Given: input controls live on short action screens, not the runtime page.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScreenRoutesSource = await fs.readFile(
      detoxScreenRoutesPath,
      "utf8",
    );

    // Then: input fields must not fall through to runtime assertion screens.
    expect(detoxScreenRoutesSource).toContain('"cohort-input": "cohortInput"');
    expect(detoxScreenRoutesSource).toContain(
      '"runtime-channel-input": "runtimeChannelInput"',
    );
    expect(detoxScreenRoutesSource).toContain(
      '"runtime-bundle-id": "runtimeBundle"',
    );
    expect(detoxPageSource).not.toContain('testID.startsWith("runtime-")');
  });

  it("opens short target-specific screens instead of scrolling the app content", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const exampleComponentSource = await fs.readFile(
      exampleE2eAppComponentsPath,
      "utf8",
    );
    const waitForTestIDBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function findVisibleTestID"),
      detoxPageSource.indexOf("module.exports"),
    );
    const openScreenBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function openScreenForTestID"),
      detoxPageSource.indexOf(
        "async function ensureAppForegroundForInteraction",
      ),
    );

    expect(exampleComponentSource).not.toContain("screenContentTestIDs");
    expect(exampleComponentSource).not.toContain("current: ScreenName");
    expect(exampleComponentSource).not.toContain("ScrollView");
    expect(openScreenBody).not.toContain('by.id("e2e-screen-content")');
    expect(openScreenBody).not.toContain('scrollTo("top")');
    expect(waitForTestIDBody).not.toContain('by.id("e2e-scroll-content")');
    expect(waitForTestIDBody).not.toContain(".whileElement(");
    expect(waitForTestIDBody).not.toContain(".scroll(");
    expect(waitForTestIDBody).not.toMatch(/\bretry\b/i);
    expect(waitForTestIDBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("waits for assertion text before reading the id-owned target", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );
    const findVisibleBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function findVisibleTestID"),
      detoxPageSource.indexOf(
        "async function withSynchronizationDisabledForAssertion",
      ),
    );

    expect(assertTextBody).toContain("expectedText");
    expect(assertTextBody).not.toContain("waitForVisibleTestIDText");
    expect(assertTextBody).toContain("waitForExpectedActionResultText(");
    expect(assertTextBody).not.toContain(
      "findVisibleTestID(this.controlClient, testID, expectedText)",
    );
    expect(findVisibleBody).toContain("const target = element(by.id(testID))");
    expect(findVisibleBody).toContain("await waitFor(target)");
    expect(findVisibleBody).not.toContain("expectedText");
    expect(detoxPageSource).not.toContain("escapeRegExp(expectedText)");
    expect(detoxPageSource).not.toContain("by.text(");
    expect(findVisibleBody).not.toMatch(/\bretry\b/i);
    expect(findVisibleBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps Detox synchronization disabled for every action tap", async () => {
    // Given: any E2E screen action can run while the app has busy OTA work.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = `${detoxPageSource}\n${detoxRuntimeSource}`;

    // When: tap handling is inspected.
    // Then: every target lookup and tap uses manual waits, not Detox idle.
    expect(tapBody).not.toContain("shouldDisableSynchronizationForTap");
    expect(
      tapBody.indexOf("await disableSynchronizationUntilLaunch();"),
    ).toBeLessThan(
      tapBody.indexOf(
        "const target = await findVisibleTestID(this.controlClient, testID)",
      ),
    );
    expect(tapBody).not.toContain("if (shouldDisableSynchronization)");
  });

  it("re-disables Detox synchronization immediately before every action tap", async () => {
    // Given: opening a screen can relaunch the app and reset Detox sync state.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );
    const targetLookupIndex = tapBody.indexOf(
      "const target = await findVisibleTestID(this.controlClient, testID)",
    );
    const tapIndex = tapBody.indexOf("await target.tap()");
    const disableIndexes = [
      ...tapBody.matchAll(/await disableSynchronizationUntilLaunch\(\);/g),
    ].map((match) => match.index ?? -1);

    // When: any action is tapped.
    // Then: sync is disabled before route lookup and again after lookup.
    expect(disableIndexes.length).toBeGreaterThanOrEqual(2);
    expect(disableIndexes[0]).toBeLessThan(targetLookupIndex);
    expect(disableIndexes[1]).toBeGreaterThan(targetLookupIndex);
    expect(disableIndexes[1]).toBeLessThan(tapIndex);
  });

  it("keeps Detox synchronization disabled for text entry actions", async () => {
    // Given: cohort input screens can still be busy after OTA state changes.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const typeTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async typeText(stage"),
      detoxRuntimeSource.indexOf("readStageValue(key)"),
    );

    // When: text entry is inspected.
    // Then: target lookup and replaceText run with sync disabled and explicit waits.
    expect(typeTextBody).toContain(
      "await disableSynchronizationUntilLaunch();",
    );
    expect(
      typeTextBody.indexOf("await disableSynchronizationUntilLaunch()"),
    ).toBeLessThan(
      typeTextBody.indexOf(
        "const target = await findVisibleTestID(this.controlClient, testID)",
      ),
    );
    expect(typeTextBody).toContain("await target.replaceText(");
    expect(typeTextBody).not.toContain("device.enableSynchronization()");
    expect(typeTextBody).not.toMatch(/\bretry\b/i);
    expect(typeTextBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps metadata jobs responsible for bundle-store verification after install completion", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(tapBody).not.toContain("waitForCurrentChannelDownload()");
    expect(detoxRuntimeSource).not.toContain(
      "function waitForCurrentChannelDownload",
    );
    expect(tapBody).toContain("await target.tap()");
    expect(tapBody).not.toContain("waitForActionStartCount");
    expect(detoxRuntimeSource).not.toContain(
      "function waitForCurrentChannelDownload",
    );
    expect(tapBody).not.toMatch(/\bretry\b/i);
  });

  it("treats rollback metadata reset as no stable active OTA", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const resetAssertionBody = controllerSource.slice(
      controllerSource.indexOf("function assertMetadataReset("),
      controllerSource.indexOf("function assertLaunchReport("),
    );
    const resetTimeoutBody = controllerSource.slice(
      controllerSource.indexOf(
        "function createWaitForMetadataResetTimeoutError",
      ),
      controllerSource.indexOf("function readIosWaitForMetadataDiagnostics"),
    );

    expect(resetAssertionBody).toContain("stableBundleId !== null");
    expect(resetAssertionBody).not.toContain("stagingBundleId !== null");
    expect(resetAssertionBody).toContain("verificationPending === true");
    expect(resetTimeoutBody).toContain("Expected stableBundleId=null");
    expect(resetTimeoutBody).not.toContain(
      "Expected stableBundleId=null, stagingBundleId=null",
    );
  });

  it("models target-cohorts-only pending verification and stable launch sequence", async () => {
    const stages = await scenarioStages("target-cohorts-only");

    // When: the Detox scenario is inspected.
    // Then: it keeps the same pending -> result -> reload -> stable order.
    expect(stages).toEqual([
      "deploy target cohort bundle",
      "launch target cohort app",
      "enter qa cohort",
      "apply qa cohort",
      "assert qa cohort applied",
      "install target cohort update",
      "assert target cohort action result",
      "wait target cohort metadata pending",
      "reload target cohort update",
      "wait target cohort metadata stable",
      "assert target cohort launch",
    ]);
    expect(
      (
        await controlStepBody(
          "target-cohorts-only",
          "wait target cohort metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "target-cohorts-only",
          "wait target cohort metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
    expect(
      (
        await controlStepBody(
          "target-cohorts-only",
          "deploy target cohort bundle",
        )
      ).rollout,
    ).toBe(0);
  });

  it("models force-update-auto-reload pending verification before stable launch", async () => {
    const stages = await scenarioStages("force-update-auto-reload");

    // When: the Detox scenario is inspected.
    // Then: it waits pending first, reloads, then verifies the stable launch.
    expect(stages).toEqual([
      "deploy force update bundle",
      "launch force update app",
      "install force update",
      "wait force update metadata pending",
      "reload force update",
      "wait force update metadata stable",
      "assert force update launch",
    ]);
    expect(
      (
        await controlStepBody(
          "force-update-auto-reload",
          "wait force update metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "force-update-auto-reload",
          "wait force update metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
  });

  it("models archive-to-diff OTA install and metadata verification sequence", async () => {
    const stages = await scenarioStages("bspatch-archive-to-diff-ota");

    // When: the Detox scenario is inspected.
    // Then: both archive and diff phases include install, pending, reload, and stable checks.
    expect(stages).toEqual([
      "deploy archive base bundle",
      "launch archive base app",
      "install archive base update",
      "wait archive base metadata pending",
      "assert first ota uses archive",
      "reload archive base update",
      "wait archive base metadata stable",
      "assert archive base bundle id",
      "assert archive base marker",
      "assert archive base stable launch",
      "deploy diff bundle",
      "assert archive diff bases",
      "launch archive diff app",
      "install archive diff update",
      "wait archive diff metadata pending",
      "reload archive diff update",
      "wait archive diff metadata stable",
      "assert archive diff patch",
      "assert archive diff bundle id",
      "assert archive diff marker",
      "assert archive diff stable launch",
    ]);
  });

  it("keeps bsdiff scenarios aligned with Maestro metadata-first assertions", async () => {
    expect(
      await updateActionResultAssertStages("bspatch-archive-to-diff-ota"),
    ).toEqual([]);
    expect(
      await updateActionResultAssertStages("bspatch-consecutive-diff-ota"),
    ).toEqual([]);
    expect(
      await updateActionResultAssertStages("bspatch-disabled-chain-rollback"),
    ).toEqual([]);
  });

  it("keeps multi-asset replacement aligned with Maestro metadata-first assertions", async () => {
    expect(
      await updateActionResultAssertStages("multi-asset-replacement"),
    ).toEqual([]);
  });

  it("keeps manifest fallback aligned with Maestro metadata-first assertions", async () => {
    expect(
      await updateActionResultAssertStages("bspatch-manifest-diff-fallback"),
    ).toEqual([]);
  });

  it("keeps archive-to-diff on the Detox default bundle profile", async () => {
    const deployBody = await controlStepBody(
      "bspatch-archive-to-diff-ota",
      "deploy archive base bundle",
    );
    expect(deployBody.bundleProfile).toBeUndefined();
  });

  it("models multi-asset replacement through stable first and second installs", async () => {
    const stages = await scenarioStages("multi-asset-replacement");

    // When: the Detox scenario is inspected.
    // Then: both bundles become stable before asset replacement assertions run.
    expect(stages).toEqual([
      "deploy first multi-asset bundle",
      "launch first multi-asset app",
      "install first multi-asset update",
      "wait first multi-asset metadata pending",
      "reload first multi-asset update",
      "wait first multi-asset metadata stable",
      "assert first multi-assets stored",
      "deploy second multi-asset bundle",
      "launch second multi-asset app",
      "install second multi-asset update",
      "wait second multi-asset metadata pending",
      "reload second multi-asset update",
      "wait second multi-asset metadata stable",
      "assert multi-assets replaced",
    ]);
    expect(
      (
        await controlStepBody(
          "multi-asset-replacement",
          "wait first multi-asset metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "multi-asset-replacement",
          "wait first multi-asset metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
    expect(
      (
        await controlStepBody(
          "multi-asset-replacement",
          "wait second multi-asset metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "multi-asset-replacement",
          "wait second multi-asset metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
  });

  it("hashes Android bundle assets through a binary-safe run-as copy path", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const readerBody = controllerSource.slice(
      controllerSource.indexOf("function androidRunAsReadablePath"),
      controllerSource.indexOf("function readAndroidFileBuffer"),
    );
    const hashBody = controllerSource.slice(
      controllerSource.indexOf("function readAndroidBundleAssetFileHash"),
      controllerSource.indexOf("function readBundleAssetFileHash"),
    );

    expect(readerBody).toContain("`/data/data/${fixtureSession.appId}/files/`");
    expect(readerBody).toContain(
      "`/data/user/0/${fixtureSession.appId}/files/`",
    );
    expect(readerBody).toContain("return `files/${remotePath.slice");
    expect(hashBody).toContain("readAndroidFileBuffer");
    expect(hashBody).toContain(".update(fileBuffer)");
    expect(hashBody).not.toContain('"sha256sum"');
  });

  it("rewrites the E2E scenario marker with a resilient declaration matcher", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );

    expect(controllerSource).toContain("const MARKER_PATTERN =");
    expect(controllerSource).toContain(
      "/export\\s+const\\s+E2E_SCENARIO_MARKER",
    );
    expect(controllerSource).toContain("(?::\\s*string)?");
    expect(controllerSource).toContain("[\"']");
    expect(controllerSource).toContain("sourceSnippet");
  });

  it("waits for consecutive bsdiff installs to become stable before asserting patch evidence", async () => {
    // Given: Android and iOS use different primary bundle asset names.
    const stages = await scenarioStages("bspatch-consecutive-diff-ota");
    const body = await controlStepBody(
      "bspatch-consecutive-diff-ota",
      "assert diff bundle C patch",
    );

    // When: the bsdiff assertion is inspected.
    // Then: C and D are both installed as bsdiff updates against stable bases.
    expect(stages).toEqual([
      "deploy diff bundle A",
      "launch diff bundle A app",
      "install diff bundle A",
      "wait diff bundle A metadata pending",
      "assert diff bundle A uses archive",
      "reload diff bundle A",
      "wait diff bundle A metadata stable",
      "assert diff bundle A launch",
      "deploy diff bundle B",
      "launch diff bundle B app",
      "install diff bundle B",
      "wait diff bundle B metadata pending",
      "reload diff bundle B",
      "wait diff bundle B metadata stable",
      "assert diff bundle B launch",
      "deploy diff bundle C",
      "assert diff bundle C bases",
      "launch diff bundle C app",
      "install diff bundle C",
      "wait diff bundle C metadata pending",
      "reload diff bundle C",
      "wait diff bundle C metadata stable",
      "assert diff bundle C patch",
      "assert diff bundle C launch",
      "deploy diff bundle D",
      "assert diff bundle D bases",
      "launch diff bundle D app",
      "install diff bundle D",
      "wait diff bundle D metadata pending",
      "reload diff bundle D",
      "wait diff bundle D metadata stable",
      "assert diff bundle D patch",
      "assert diff bundle D launch",
    ]);
    expect(body.assetPath).toBe("$diffPatchAssetPath");
  });

  it("resolves auto patch metadata from the provider-visible bundle record", async () => {
    // Given: standalone providers can expose a just-deployed bundle through the
    // same CLI surface used by provider assertions before a direct database
    // plugin read observes it.
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const resolverSource = controllerSource.slice(
      controllerSource.indexOf("async function resolveAutoPatchBundleDiff"),
      controllerSource.indexOf("async function deleteProviderBundle"),
    );

    // When: the auto-patch metadata resolver waits for patch fields.
    // Then: it must use the provider-visible bundle record, not a direct
    // database-only read that can race or diverge from the provider surface.
    expect(resolverSource).toContain(
      "const bundle = await fetchProviderBundleById(bundleId);",
    );
    expect(resolverSource).not.toContain(
      "fetchProviderBundleByIdFromDatabase(bundleId)",
    );
  });

  it("models manifest diff fallback through an installed previous bundle", async () => {
    const stages = await scenarioStages("bspatch-manifest-diff-fallback");

    // When: the Detox scenario is inspected.
    // Then: previous OTA state exists in the bundle store before fallback.
    expect(stages).toEqual([
      "deploy manifest base bundle",
      "launch manifest base app",
      "install manifest base update",
      "wait manifest base metadata pending",
      "reload manifest base update",
      "wait manifest base metadata stable",
      "deploy manifest intermediate bundle",
      "deploy manifest fallback bundle",
      "assert manifest fallback patch bases",
      "launch manifest fallback app",
      "install manifest fallback update",
      "wait manifest fallback metadata pending",
      "reload manifest fallback update",
      "wait manifest fallback metadata stable",
      "assert manifest diff fallback",
    ]);
  });

  it("accepts Android manifest fallback evidence when adb cannot hash an existing bundle file", async () => {
    // Given: Android can report ENOBUFS while reading a private bundle file even
    // though the bundle file exists and the manifest contains the expected hash.
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const manifestStateBody = controllerSource.slice(
      controllerSource.indexOf("async function readManifestDiffState"),
      controllerSource.indexOf("async function assertBundleAssetsStored"),
    );

    // When: manifest fallback evidence is evaluated.
    // Then: recoverable adb read failures use manifest plus bundle existence.
    expect(controllerSource).toContain(
      "function hasManifestBackedBundleEvidence",
    );
    expect(controllerSource).toContain("isRecoverableAndroidAssetReadError");
    expect(manifestStateBody).toContain("hasManifestBackedBundleEvidence({");
    expect(controllerSource).toContain("assetFile.readError");
    expect(controllerSource).toContain("bundleFile.exists");
    expect(controllerSource).toContain("expectedHash !== null");
  });

  it("models release recovery without relaunching over recovered state", async () => {
    const stages = await scenarioStages("release-ota-recovery");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "deploy stable bundle",
      "launch stable update app",
      "install stable update",
      "wait stable metadata pending",
      "reload stable bundle",
      "wait stable metadata active",
      "assert stable launch",
      "deploy crash bundle",
      "launch crash update app",
      "install crash update",
      "wait crash metadata pending",
      "launch crash bundle",
      "wait crash recovery",
      "assert recovery launch report",
      "assert recovered bundle id",
      "assert recovered marker",
      "assert recovered metadata active",
      "assert crash history",
    ]);
  });

  it("reattaches Android Detox after control-server crash recovery", async () => {
    // Given: the control server relaunches Android outside Detox while waiting
    // for the native recovery marker.
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const reattachBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async reattachAfterExternalLaunch"),
      detoxRuntimeSource.indexOf("module.exports"),
    );

    // When: the wait-for-crash-recovery control step completes.
    // Then: Android reconnects through Detox without adding a scenario-level relaunch.
    expect(reattachBody).toContain(
      'pathName !== "/e2e/wait-for-crash-recovery"',
    );
    expect(reattachBody).toContain("if (!isAndroidRun()) return;");
    expect(reattachBody).toContain("await launchApp({ newInstance: false });");
    expect(reattachBody).not.toMatch(/\bretry\b/i);
    expect(await scenarioStages("release-ota-recovery")).not.toContain(
      "launch recovered app",
    );
  });

  it("waits for cohort rollout metadata to become stable before active assertion", async () => {
    const stages = await scenarioStages("target-cohorts-rollout-interaction");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "deploy cohort rollout bundle",
      "expand cohort rollout bundle",
      "compute cohort rollout sample",
      "launch cohort rollout app",
      "enter excluded cohort",
      "apply excluded cohort",
      "assert excluded cohort applied",
      "install excluded cohort update",
      "assert excluded cohort no update",
      "assert excluded metadata reset",
      "reload excluded cohort state",
      "assert excluded cohort built-in bundle",
      "enter included cohort",
      "apply included cohort",
      "assert included cohort applied",
      "install included cohort update",
      "assert included cohort action result",
      "wait included cohort metadata pending",
      "reload included cohort update",
      "wait included cohort metadata stable",
      "assert included cohort bundle",
      "restore excluded cohort",
      "apply restored excluded cohort",
      "assert restored excluded cohort applied",
      "install restored excluded cohort update",
      "assert restored excluded cohort rollback action result",
      "assert restored excluded metadata reset",
      "reload restored excluded cohort state",
      "assert restored excluded built-in bundle",
      "apply qa cohort",
      "assert qa cohort applied",
      "install qa cohort update",
      "assert qa cohort action result",
      "wait qa cohort metadata pending",
      "reload qa cohort update",
      "wait qa cohort metadata stable",
      "assert qa cohort bundle",
      "assert qa cohort active",
    ]);
    expect(
      (
        await controlStepBody(
          "target-cohorts-rollout-interaction",
          "wait included cohort metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "target-cohorts-rollout-interaction",
          "wait included cohort metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
    expect(
      (await recordScenarioCalls("target-cohorts-rollout-interaction")).find(
        (call) =>
          call.kind === "assertText" &&
          call.stage ===
            "assert restored excluded cohort rollback action result",
      ),
    ).toMatchObject({
      contains:
        "current-channel -> installed 00000000-0000-0000-0000-000000000000",
      options: { exactText: true },
      testID: "update-action-result",
    });
  });

  it("models runtime channel switching as an OTA state transition", async () => {
    const stages = await scenarioStages("runtime-channel-switch-reset");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "launch built-in runtime channel app",
      "assert runtime channel built-in marker",
      "assert runtime channel initial current",
      "assert runtime channel initial default",
      "assert runtime channel initially not switched",
      "deploy runtime channel bundle",
      "launch runtime channel app",
      "install runtime channel update",
      "wait runtime channel metadata pending",
      "assert runtime channel result",
      "reload runtime channel update",
      "assert runtime channel bundle",
      "assert runtime channel marker",
      "assert runtime channel launch status",
      "assert runtime channel switched current",
      "assert runtime channel switched default",
      "assert runtime channel switched",
      "reset runtime channel",
      "assert runtime channel reset",
      "reload default channel",
      "assert reset built-in bundle",
      "assert reset built-in marker",
      "assert reset launch status",
      "assert reset current channel",
      "assert reset default channel",
      "assert reset channel not switched",
      "assert reset crash history empty",
    ]);
    expect(
      (
        await controlStepBody(
          "runtime-channel-switch-reset",
          "wait runtime channel metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (await recordScenarioCalls("runtime-channel-switch-reset")).some(
        (call) => call.kind === "typeText",
      ),
    ).toBe(false);
    expect(
      (await recordScenarioCalls("runtime-channel-switch-reset")).filter(
        (call) =>
          call.kind === "reload" &&
          ["reload runtime channel update", "reload default channel"].includes(
            call.stage,
          ),
      ),
    ).toHaveLength(2);
    expect(
      (await recordScenarioCalls("runtime-channel-switch-reset")).some(
        (call) => call.kind === "tap" && call.testID === "action-reload-app",
      ),
    ).toBe(false);
  });

  it("models numeric cohort rollout through an included rollout sample", async () => {
    const stages = await scenarioStages("numeric-cohort-rollout");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "deploy numeric cohort bundle",
      "compute rollout sample",
      "launch numeric cohort app",
      "enter included cohort",
      "apply included cohort",
      "assert included cohort applied",
      "install rollout update",
      "assert rollout action result",
      "wait rollout metadata pending",
      "reload rollout update",
      "wait rollout metadata stable",
      "assert rollout launch",
      "enter excluded cohort",
      "apply excluded cohort",
      "assert excluded cohort applied",
      "install excluded cohort update",
      "assert excluded cohort rollback action result",
      "assert excluded metadata reset",
      "reload excluded cohort state",
      "assert excluded cohort built-in bundle",
    ]);
    expect(
      (
        await controlStepDefinition(
          "numeric-cohort-rollout",
          "compute rollout sample",
        )
      ).options?.saveResultFieldsAs,
    ).toEqual({
      excludedCohort: "excludedCohort",
      includedCohort: "includedCohort",
    });
    expect(
      (
        await controlStepBody(
          "numeric-cohort-rollout",
          "deploy numeric cohort bundle",
        )
      ).rollout,
    ).toBe(10);
    expect(
      (
        await controlStepBody(
          "numeric-cohort-rollout",
          "deploy numeric cohort bundle",
        )
      ).safeBundleIds,
    ).toEqual(["$builtInBundleId"]);
    expect(
      (
        await controlStepBody(
          "numeric-cohort-rollout",
          "wait rollout metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "numeric-cohort-rollout",
          "wait rollout metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
    expect(
      Object.hasOwn(
        (await recordScenarioCalls("numeric-cohort-rollout")).find(
          (call) =>
            call.kind === "tap" &&
            call.stage === "install excluded cohort update",
        ) ?? {},
        "expectedResultContains",
      ),
    ).toBe(false);
    expect(
      (await recordScenarioCalls("numeric-cohort-rollout")).find(
        (call) =>
          call.kind === "assertText" &&
          call.stage === "assert excluded cohort rollback action result",
      ),
    ).toMatchObject({
      contains:
        "current-channel -> installed 00000000-0000-0000-0000-000000000000",
      options: { exactText: true },
      testID: "update-action-result",
    });
  });

  it("models targeted cohort switchback as bundle state, not restore text", async () => {
    const stages = await scenarioStages("targeted-cohort-switchback");

    // When: the Detox scenario is inspected.
    // Then: the switchback asserts reloaded bundle state instead of restore UI text.
    expect(stages).toEqual([
      "deploy numeric cohort bundle",
      "compute numeric rollout sample",
      "deploy qa cohort bundle",
      "launch targeted cohort app",
      "enter numeric cohort",
      "apply numeric cohort",
      "assert numeric cohort applied",
      "install numeric cohort update",
      "assert numeric cohort action result",
      "wait numeric cohort metadata pending",
      "reload numeric cohort update",
      "wait numeric cohort metadata stable",
      "assert numeric cohort launch",
      "set qa cohort",
      "assert qa cohort applied",
      "assert qa cohort current",
      "install qa cohort update",
      "wait qa cohort metadata pending",
      "reload qa cohort update",
      "wait qa cohort metadata stable",
      "assert qa cohort launch",
      "restore numeric cohort",
      "apply restored numeric cohort",
      "assert numeric cohort restored",
      "install numeric cohort rollback",
      "wait numeric cohort rollback pending",
      "reload numeric cohort rollback",
      "wait numeric cohort rollback stable",
      "assert numeric cohort rollback launch",
    ]);
    expect(
      await updateActionResultAssertStages("targeted-cohort-switchback"),
    ).toEqual(["assert numeric cohort action result"]);
    expect(
      (await recordScenarioCalls("targeted-cohort-switchback")).find(
        (call) => call.stage === "assert qa cohort current",
      ),
    ).toMatchObject({
      contains: "qa",
      kind: "assertText",
      testID: "runtime-current-cohort",
    });
  });

  it("models disabled rollback scenarios through active OTA metadata before disabling", async () => {
    // Given: rollback scenarios must first stabilize the OTA that will be disabled.
    const builtinStages = await scenarioStages(
      "disabled-bundle-rollback-to-builtin",
    );
    const previousStages = await scenarioStages(
      "disabled-bundle-rollback-to-previous-ota",
    );

    // When: both Detox rollback scenarios are inspected.
    // Then: each disables only after pending, reload, stable, and active checks.
    expect(builtinStages).toEqual([
      "capture built-in bundle",
      "launch built-in rollback app",
      "assert rollback built-in marker",
      "deploy current bundle",
      "launch current bundle app",
      "install current bundle",
      "assert current bundle action result",
      "wait current bundle metadata pending",
      "reload current bundle",
      "wait current bundle metadata stable",
      "assert current bundle marker",
      "assert current bundle launch status",
      "assert current bundle active",
      "disable current bundle",
      "install rollback to built-in",
      "assert rollback to built-in action result",
      "assert rollback metadata reset",
      "reload rollback to built-in app",
      "assert rollback built-in bundle",
      "assert rollback built-in marker",
      "assert rollback launch status",
      "assert no crashed bundle",
      "assert rollback crash history empty",
      "capture rollback built-in state",
      "assert rollback metadata reset again",
    ]);
    const rollbackMetadataStep = await controlStepDefinition(
      "disabled-bundle-rollback-to-builtin",
      "assert rollback metadata reset",
    );
    expect(rollbackMetadataStep.pathName).toBe("/e2e/assert-metadata-reset");
    expect(rollbackMetadataStep.body).toBeUndefined();
    expect(
      (await recordScenarioCalls("disabled-bundle-rollback-to-builtin")).find(
        (call) =>
          call.kind === "assertText" &&
          call.stage === "assert rollback to built-in action result",
      ),
    ).toMatchObject({
      contains:
        "current-channel -> installed 00000000-0000-0000-0000-000000000000",
      options: { exactText: true },
      testID: "update-action-result",
    });
    expect(previousStages).toEqual([
      "capture built-in bundle",
      "launch built-in previous rollback app",
      "assert previous rollback built-in marker",
      "deploy previous bundle",
      "launch previous bundle app",
      "install previous bundle",
      "assert previous bundle action result",
      "wait previous bundle metadata pending",
      "reload previous bundle",
      "wait previous bundle metadata stable",
      "assert previous bundle marker",
      "assert previous bundle launch status",
      "assert previous bundle active",
      "deploy next bundle",
      "launch next bundle app",
      "install next bundle",
      "assert next bundle action result",
      "wait next bundle metadata pending",
      "reload next bundle",
      "wait next bundle metadata stable",
      "assert next bundle marker",
      "assert next bundle launch status",
      "assert next bundle active",
      "disable next bundle",
      "install rollback to previous ota",
      "assert previous ota rollback action result",
      "wait previous rollback metadata pending",
      "reload rollback to previous app",
      "wait previous rollback metadata stable",
      "assert previous ota rollback marker",
      "assert previous ota rollback launch status",
      "assert previous ota rollback crashed bundle",
      "assert previous ota rollback crash history empty",
      "capture previous ota rollback state",
      "assert previous ota active",
    ]);
  });

  it("treats a rollback stable bundle as active metadata", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const activePredicateBody = controllerSource.slice(
      controllerSource.indexOf("function isMetadataActiveBundle"),
      controllerSource.indexOf("function isExpectedMetadataStateReached"),
    );
    const expectedStateBody = controllerSource.slice(
      controllerSource.indexOf("function isExpectedMetadataStateReached"),
      controllerSource.indexOf("function isExpectedCrashRecoveryReached"),
    );

    expect(activePredicateBody).toContain(
      "metadataState.stagingBundleId === bundleId ||",
    );
    expect(activePredicateBody).toContain(
      "metadataState.stableBundleId === bundleId",
    );
    expect(expectedStateBody).toContain(
      "isMetadataActiveBundle(metadataState, bundleId)",
    );
    expect(expectedStateBody).not.toContain(
      "metadataState.stagingBundleId !== bundleId",
    );
  });

  it("models disabled bsdiff chain rollback through C to B to A to built-in", async () => {
    const stages = await scenarioStages("bspatch-disabled-chain-rollback");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "launch built-in chain app",
      "assert chain built-in marker",
      "reset chain local app state",
      "deploy chain bundle A",
      "launch chain bundle A app",
      "install chain bundle A",
      "wait chain bundle A metadata pending",
      "assert chain bundle A uses archive",
      "reload chain bundle A",
      "wait chain bundle A metadata stable",
      "assert chain bundle A marker",
      "assert chain bundle A launch",
      "assert chain bundle A launch status",
      "deploy chain bundle B",
      "launch chain bundle B app",
      "install chain bundle B",
      "wait chain bundle B metadata pending",
      "reload chain bundle B",
      "wait chain bundle B metadata stable",
      "assert chain bundle B marker",
      "assert chain bundle B launch",
      "assert chain bundle B launch status",
      "deploy chain bundle C",
      "assert chain bundle C bases",
      "launch chain bundle C app",
      "install chain bundle C",
      "wait chain bundle C metadata pending",
      "reload chain bundle C",
      "wait chain bundle C metadata stable",
      "assert chain bundle C patch",
      "assert chain bundle C marker",
      "assert chain bundle C launch",
      "assert chain bundle C launch status",
      "assert chain bundle C crash history empty",
      "capture chain bundle C state",
      "assert chain bundle C active",
      "disable chain bundle C",
      "restart rollback to chain bundle B",
      "wait chain bundle B rollback metadata stable",
      "reload chain bundle B rollback",
      "assert chain bundle B rollback marker",
      "assert chain bundle B rollback launch",
      "assert chain bundle B rollback launch status",
      "assert chain bundle B rollback crashed bundle",
      "assert chain bundle B rollback active",
      "disable chain bundle B",
      "restart rollback to chain bundle A",
      "wait chain bundle A rollback metadata stable",
      "reload chain bundle A rollback",
      "assert chain bundle A rollback marker",
      "assert chain bundle A rollback launch",
      "assert chain bundle A rollback launch status",
      "assert chain bundle A rollback crashed bundle",
      "assert chain bundle A rollback active",
      "disable chain bundle A",
      "restart rollback to built-in chain",
      "assert chain built-in metadata reset",
      "reload built-in chain rollback",
      "assert chain built-in bundle",
      "assert chain built-in marker after rollback",
      "assert chain built-in launch status",
      "assert chain built-in crashed bundle",
      "assert chain built-in crash history empty",
      "capture chain built-in rollback state",
      "assert chain built-in metadata reset again",
    ]);
    expect(
      await updateActionResultAssertStages("bspatch-disabled-chain-rollback"),
    ).toEqual([]);
  });

  it("accepts Android bsdiff patch evidence through manifest-backed store state", async () => {
    const controllerSource = await fs.readFile(
      detoxControlServerControllerPath,
      "utf8",
    );
    const bsdiffEvidenceBody = controllerSource.slice(
      controllerSource.indexOf("function readBsdiffPatchStoreEvidence"),
      controllerSource.indexOf("function getPrimaryBundleAssetPath"),
    );

    expect(bsdiffEvidenceBody).toContain(
      "const bundleFile = readBundleFileSnapshot(record.bundleId);",
    );
    expect(bsdiffEvidenceBody).toContain("hasManifestBackedBundleEvidence({");
    expect(bsdiffEvidenceBody).toContain("bundleFile,");
    expect(bsdiffEvidenceBody).toContain("assetFile,");
    expect(bsdiffEvidenceBody).toContain("expectedHash,");
    expect(bsdiffEvidenceBody).toContain("manifest,");
  });
});

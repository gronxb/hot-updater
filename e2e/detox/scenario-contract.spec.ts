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
      readonly kind: "assertText";
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
    assertText: (stage, testID) => {
      calls.push({ kind: "assertText", stage, testID });
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
      const firstLaunchIndex = calls.findIndex(
        (call) => call.kind === "launch",
      );
      const firstUiIndex = calls.findIndex(
        (call) =>
          call.kind === "assertText" ||
          call.kind === "tap" ||
          call.kind === "typeText",
      );

      expect(firstDeployIndex, scenarioName).toBeGreaterThan(-1);
      if (firstUiIndex === -1) {
        expect(firstLaunchIndex, scenarioName).toBe(-1);
        continue;
      }
      if (baselineBeforeDeployScenarios.has(scenarioName)) {
        const preDeployCalls = calls.slice(0, firstDeployIndex);
        expect(
          preDeployCalls.some(
            (call) =>
              call.kind === "launch" && call.stage.includes("built-in"),
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
      expect(firstLaunchIndex, scenarioName).toBeGreaterThan(firstDeployIndex);
      expect(firstUiIndex, scenarioName).toBeGreaterThan(firstLaunchIndex);
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

    expect(exampleAppSource).toContain("./src/e2eRuntimeConfig");
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

  it("does not gate install taps on immediate action-result text", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(tapBody).toContain("await target.tap()");
    expect(tapBody).not.toContain("expectedResultContains");
    expect(tapBody).not.toContain("waitForInstallActionResult");
    expect(detoxRuntimeSource).not.toContain(
      "async waitForInstallActionResult",
    );
    expect(detoxRuntimeSource).not.toContain("metadata.json");
    expect(detoxRuntimeSource).not.toContain("by.text(new RegExp");
    expect(detoxRuntimeSource).not.toContain(".and(");
    expect(tapBody).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps install action result checks after metadata evidence", async () => {
    const scenariosWithActionResultAssertions = [
      "numeric-cohort-rollout",
      "release-ota-recovery",
      "target-cohorts-only",
      "target-cohorts-rollout-interaction",
      "targeted-cohort-switchback",
    ] as const;

    for (const scenarioName of scenariosWithActionResultAssertions) {
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
        expect(
          Object.hasOwn(calls[index] ?? {}, "expectedResultContains"),
          stageLabel,
        ).toBe(false);
        const metadataIndex = calls.findIndex(
          (entry, nextIndex) =>
            nextIndex > index &&
            entry.kind === "control" &&
            entry.pathName === "/e2e/jobs/wait-for-metadata",
        );
        const actionResultIndex = calls.findIndex(
          (entry, nextIndex) =>
            nextIndex > index &&
            entry.kind === "assertText" &&
            entry.testID === "update-action-result",
        );
        if (actionResultIndex !== -1) {
          expect(metadataIndex, stageLabel).toBeGreaterThan(index);
          expect(actionResultIndex, stageLabel).toBeGreaterThan(metadataIndex);
        }
      }
    }
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
      detoxPageSource.indexOf("function navTargetForTestID"),
    );

    expect(installTapBody).toContain("disableSynchronizationUntilLaunch()");
    expect(syncHelperBody).toContain("device.disableSynchronization()");
    expect(syncHelperBody).toContain("synchronizationDisabledUntilLaunch");
    expect(installTapBody).not.toContain("waitForInstallActionResult");
    expect(installTapBody).not.toContain("{ ensureForeground: false }");
    expect(installTapBody).not.toContain("expectedResultContains");
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
      detoxPageSource.indexOf("function navTargetForTestID"),
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

  it("reattaches after install taps without waiting on result text", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const installTapBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async tap(stage"),
      detoxRuntimeSource.indexOf("async terminate(stage"),
    );

    expect(installTapBody).not.toContain("isAndroidRun()");
    expect(installTapBody).toContain("if (isInstallAction) {");
    expect(installTapBody).not.toContain("if (expectedResultContains) {");
    expect(installTapBody).not.toContain("waitForInstallActionResult");
    expect(detoxRuntimeSource).not.toContain(
      "async waitForInstallActionResult",
    );
    expect(detoxRuntimeSource).not.toContain("by.text(new RegExp");
    expect(detoxRuntimeSource).not.toContain(".withTimeout(30000)");
    expect(installTapBody).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
  });

  it("uses action result elements only for explicit assertions", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const exampleAppSource = await fs.readFile(exampleAppPath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const assertTextBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async assertText(stage"),
      detoxRuntimeSource.indexOf("async control(stage"),
    );

    expect(exampleAppSource).toContain('testID="update-action-result"');
    expect(detoxPageSource).toContain('testID.endsWith("-result")');
    expect(detoxPageSource).toContain("e2e-nav-action-results");
    expect(detoxRuntimeSource).toContain(".toBeVisible()");
    expect(detoxRuntimeSource).not.toContain("escapeRegExp");
    expect(detoxRuntimeSource).not.toContain(
      "async waitForInstallActionResult",
    );
    expect(assertTextBody).toContain("findVisibleTestID(");
    expect(assertTextBody).toContain("textFromAttributes");
    expect(detoxRuntimeSource).not.toMatch(/\bretry\b/i);
    expect(detoxRuntimeSource).not.toMatch(/\bsetTimeout\b/i);
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

  it("keeps launch status assertions on the top section instead of action results", async () => {
    // Given: launch status lives in the Runtime Snapshot/Launch Status area.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");

    // When: the navigation target resolver is inspected.
    const launchStatusIndex = detoxPageSource.indexOf(
      'testID === "launch-status-result"',
    );
    const genericResultIndex = detoxPageSource.indexOf(
      'testID.endsWith("-result")',
    );

    // Then: the top-section special case must win before the generic result tab.
    expect(launchStatusIndex).toBeGreaterThan(-1);
    expect(launchStatusIndex).toBeLessThan(genericResultIndex);
  });

  it("routes action inputs to the actions section before generic runtime fields", async () => {
    // Given: runtime-channel-input is rendered under the Actions section.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");

    // When: the navigation target resolver is inspected.
    const inputIndex = detoxPageSource.indexOf('testID.endsWith("-input")');
    const runtimeIndex = detoxPageSource.indexOf(
      'testID.startsWith("runtime-")',
    );

    // Then: input fields must not be routed to the top section.
    expect(inputIndex).toBeGreaterThan(-1);
    expect(inputIndex).toBeLessThan(runtimeIndex);
  });

  it("scrolls inside the app content when Android layout offsets are not ready", async () => {
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const exampleAppSource = await fs.readFile(exampleAppPath, "utf8");
    const waitForTestIDBody = detoxPageSource.slice(
      detoxPageSource.indexOf("async function findVisibleTestID"),
      detoxPageSource.indexOf("module.exports"),
    );

    expect(exampleAppSource).toContain('testID="e2e-scroll-content"');
    expect(waitForTestIDBody).toContain('by.id("e2e-scroll-content")');
    expect(waitForTestIDBody).toContain(".whileElement(");
    expect(waitForTestIDBody).toContain('.scroll(260, "down")');
    expect(waitForTestIDBody).not.toMatch(/\bretry\b/i);
    expect(waitForTestIDBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("only disables Detox synchronization for install taps", async () => {
    // Given: install buttons can start native download work that Detox sees as busy.
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const tapBody = `${detoxPageSource}\n${detoxRuntimeSource}`;

    // When: tap handling is inspected.
    // Then: cohort/channel utility buttons keep normal synchronization.
    expect(tapBody).toContain("shouldDisableSynchronizationForTap");
    expect(tapBody).toContain('testID.startsWith("action-install-")');
    expect(tapBody).not.toContain(
      "await disableSynchronizationUntilLaunch();\n  await target.tap();",
    );
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
    expect(tapBody).not.toContain("waitForInstallActionResult");
    expect(detoxRuntimeSource).not.toContain(
      "function waitForCurrentChannelDownload",
    );
    expect(tapBody).not.toMatch(/\bretry\b/i);
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
      "wait target cohort metadata pending",
      "assert target cohort action result",
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
      "assert crash action result",
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
      "assert excluded metadata reset",
      "reload excluded cohort state",
      "assert excluded cohort built-in bundle",
      "enter included cohort",
      "apply included cohort",
      "assert included cohort applied",
      "install included cohort update",
      "wait included cohort metadata pending",
      "assert included cohort action result",
      "reload included cohort update",
      "wait included cohort metadata stable",
      "assert included cohort bundle",
      "restore excluded cohort",
      "apply restored excluded cohort",
      "assert restored excluded cohort applied",
      "install restored excluded cohort update",
      "assert restored excluded metadata reset",
      "reload restored excluded cohort state",
      "assert restored excluded built-in bundle",
      "apply qa cohort",
      "assert qa cohort applied",
      "install qa cohort update",
      "wait qa cohort metadata pending",
      "assert qa cohort action result",
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
  });

  it("models runtime channel switching as an OTA state transition", async () => {
    const stages = await scenarioStages("runtime-channel-switch-reset");

    expect(stages).toEqual([
      "capture built-in bundle id",
      "launch built-in runtime channel app",
      "assert runtime channel built-in marker",
      "assert runtime channel initial summary",
      "deploy runtime channel bundle",
      "launch runtime channel app",
      "install runtime channel update",
      "wait runtime channel metadata pending",
      "assert runtime channel result",
      "reload runtime channel update",
      "assert runtime channel bundle",
      "assert runtime channel marker",
      "assert runtime channel launch status",
      "assert runtime channel switched summary",
      "reset runtime channel",
      "assert runtime channel reset",
      "reload default channel",
      "assert reset built-in bundle",
      "assert reset built-in marker",
      "assert reset launch status",
      "assert reset channel summary",
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
        (call) => call.kind === "tap" && call.testID === "action-reload-app",
      ),
    ).toHaveLength(2);
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
      "wait rollout metadata pending",
      "assert rollout action result",
      "reload rollout update",
      "wait rollout metadata stable",
      "assert rollout launch",
      "enter excluded cohort",
      "apply excluded cohort",
      "assert excluded cohort applied",
      "install excluded cohort update",
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
      "wait numeric cohort metadata pending",
      "assert numeric cohort action result",
      "reload numeric cohort update",
      "wait numeric cohort metadata stable",
      "assert numeric cohort launch",
      "enter qa cohort",
      "apply qa cohort",
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
      "wait current bundle metadata pending",
      "reload current bundle",
      "wait current bundle metadata stable",
      "assert current bundle marker",
      "assert current bundle launch status",
      "assert current bundle active",
      "disable current bundle",
      "launch rollback to built-in app",
      "assert rollback metadata reset",
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
    expect(previousStages).toEqual([
      "capture built-in bundle",
      "launch built-in previous rollback app",
      "assert previous rollback built-in marker",
      "deploy previous bundle",
      "launch previous bundle app",
      "install previous bundle",
      "wait previous bundle metadata pending",
      "reload previous bundle",
      "wait previous bundle metadata stable",
      "assert previous bundle marker",
      "assert previous bundle launch status",
      "assert previous bundle active",
      "deploy next bundle",
      "launch next bundle app",
      "install next bundle",
      "wait next bundle metadata pending",
      "reload next bundle",
      "wait next bundle metadata stable",
      "assert next bundle marker",
      "assert next bundle launch status",
      "assert next bundle active",
      "disable next bundle",
      "launch rollback to previous app",
      "wait previous rollback metadata stable",
      "assert previous ota rollback marker",
      "assert previous ota rollback launch status",
      "assert previous ota rollback crashed bundle",
      "assert previous ota rollback crash history empty",
      "capture previous ota rollback state",
      "assert previous ota active",
    ]);
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
      "reload rollback to chain bundle B",
      "wait chain bundle B rollback metadata stable",
      "assert chain bundle B rollback marker",
      "assert chain bundle B rollback launch",
      "assert chain bundle B rollback launch status",
      "assert chain bundle B rollback crashed bundle",
      "assert chain bundle B rollback active",
      "disable chain bundle B",
      "reload rollback to chain bundle A",
      "wait chain bundle A rollback metadata stable",
      "assert chain bundle A rollback marker",
      "assert chain bundle A rollback launch",
      "assert chain bundle A rollback launch status",
      "assert chain bundle A rollback crashed bundle",
      "assert chain bundle A rollback active",
      "disable chain bundle A",
      "reload rollback to built-in chain",
      "assert chain built-in metadata reset",
      "assert chain built-in bundle",
      "assert chain built-in marker after rollback",
      "assert chain built-in launch status",
      "assert chain built-in crashed bundle",
      "assert chain built-in crash history empty",
      "capture chain built-in rollback state",
      "assert chain built-in metadata reset again",
    ]);
  });
});

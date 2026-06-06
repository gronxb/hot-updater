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
    expect(detoxRuntimeSource).toContain("/e2e/reset-remote-bundles");
    expect(detoxRuntimeSource).toContain("/e2e/reset-local-app-state");
  });

  it("does not delete seeded control-server app state after reset", async () => {
    // Given: the control server resets remote bundles and local app state
    // before the first cold launch can request an update-check URL.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const beforeEachBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("beforeEach(async () =>"),
      detoxJestSpec.indexOf("\n  afterEach(async () =>"),
    );

    // When: Detox launches the app after reset.
    const bootstrapIndex = beforeEachBody.indexOf("/e2e/jobs/bootstrap");
    const resetRemoteIndex = beforeEachBody.indexOf(
      "/e2e/reset-remote-bundles",
    );
    const resetLocalIndex = beforeEachBody.indexOf(
      "/e2e/reset-local-app-state",
    );
    const launchIndex = beforeEachBody.indexOf("launchApp");

    // Then: launch keeps the freshly reset/seeded data instead of deleting it.
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(resetRemoteIndex).toBeGreaterThan(bootstrapIndex);
    expect(resetLocalIndex).toBeGreaterThan(resetRemoteIndex);
    expect(launchIndex).toBeGreaterThan(resetLocalIndex);
    expect(beforeEachBody).toContain("launchApp({ newInstance: true })");
    expect(beforeEachBody).not.toContain("delete: true");
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

  it("lets control metadata prove install actions instead of waiting on busy UI text", async () => {
    const installSteps = [
      ["release-ota-recovery", "install stable update"],
      ["release-ota-recovery", "install crash update"],
      ["bspatch-manifest-diff-fallback", "install manifest base update"],
      ["bspatch-manifest-diff-fallback", "install manifest fallback update"],
      ["runtime-channel-switch-reset", "install runtime channel update"],
      ["disabled-bundle-rollback-to-previous-ota", "install previous bundle"],
    ] as const;

    for (const [scenarioName, stage] of installSteps) {
      const call = (await recordScenarioCalls(scenarioName)).find(
        (entry) => entry.stage === stage,
      );

      expect(call).toMatchObject({
        kind: "tap",
        testID: expect.stringContaining("action-install-"),
      });
      expect(call).not.toHaveProperty("expectResultContains");
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
    expect(installTapBody).not.toContain("step.expectResultContains");
    expect(installTapBody).not.toContain(
      'waitForVisibleText("update-action-result"',
    );
    expect(installTapBody).not.toContain("device.enableSynchronization()");
    expect(installTapBody).not.toContain("finally");
    expect(deviceActionBody).toContain(
      "await launchApp({ newInstance: true })",
    );
    expect(installTapBody).not.toMatch(/\bretry\b/i);
    expect(installTapBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("keeps Detox synchronization disabled across explicit reloads", async () => {
    const detoxRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );
    const reloadBody = detoxRuntimeSource.slice(
      detoxRuntimeSource.indexOf("async reload(stage"),
      detoxRuntimeSource.indexOf("async resetAppState(stage"),
    );

    expect(reloadBody).toContain("disableSynchronizationUntilLaunch()");
    expect(reloadBody).toContain("await launchApp({ newInstance: true })");
    expect(reloadBody).not.toContain("device.enableSynchronization()");
    expect(reloadBody).not.toContain("finally");
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

  it("taps install actions directly and lets metadata jobs prove downloads", async () => {
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
    expect(tapBody).not.toMatch(/\bretry\b/i);
  });

  it("models target-cohorts-only pending verification and stable launch sequence", async () => {
    const stages = await scenarioStages("target-cohorts-only");

    // When: the Detox scenario is inspected.
    // Then: it keeps the same pending -> result -> reload -> stable order.
    expect(stages).toEqual([
      "deploy target cohort bundle",
      "enter qa cohort",
      "apply qa cohort",
      "assert qa cohort applied",
      "install target cohort update",
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
      "launch built-in app",
      "deploy first multi-asset bundle",
      "install first multi-asset update",
      "wait first multi-asset metadata pending",
      "reload first multi-asset update",
      "wait first multi-asset metadata stable",
      "assert first multi-assets stored",
      "deploy second multi-asset bundle",
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
      "assert consecutive diff patch",
    );

    // When: the bsdiff assertion is inspected.
    // Then: the diff is installed against a stable base and uses the deploy result path.
    expect(stages).toEqual([
      "deploy first diff bundle",
      "install first diff bundle",
      "wait first diff metadata pending",
      "reload first diff bundle",
      "wait first diff metadata stable",
      "deploy second diff bundle",
      "install second diff bundle",
      "wait second diff metadata pending",
      "reload second diff bundle",
      "wait second diff metadata stable",
      "assert consecutive diff patch",
    ]);
    expect(body.assetPath).toBe("$diffPatchAssetPath");
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
      "launch built-in app",
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
      "deploy cohort rollout bundle",
      "enter qa cohort",
      "apply qa cohort",
      "install cohort rollout update",
      "wait cohort rollout metadata pending",
      "reload cohort rollout update",
      "wait cohort rollout metadata stable",
      "assert cohort rollout active",
    ]);
    expect(
      (
        await controlStepBody(
          "target-cohorts-rollout-interaction",
          "wait cohort rollout metadata pending",
        )
      ).verificationPending,
    ).toBe(true);
    expect(
      (
        await controlStepBody(
          "target-cohorts-rollout-interaction",
          "wait cohort rollout metadata stable",
        )
      ).verificationPending,
    ).toBe(false);
  });

  it("models runtime channel switching as an OTA state transition", async () => {
    const stages = await scenarioStages("runtime-channel-switch-reset");

    expect(stages).toEqual([
      "launch default channel",
      "capture built-in bundle id",
      "deploy runtime channel bundle",
      "install runtime channel update",
      "wait runtime channel metadata pending",
      "assert runtime channel result",
      "reload runtime channel update",
      "assert runtime channel bundle",
      "reset runtime channel",
      "assert runtime channel reset",
      "reload default channel",
      "assert reset built-in bundle",
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
  });

  it("models numeric cohort rollout through an included rollout sample", async () => {
    const stages = await scenarioStages("numeric-cohort-rollout");

    expect(stages).toEqual([
      "launch built-in app",
      "capture built-in bundle id",
      "deploy numeric cohort bundle",
      "compute rollout sample",
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
  });

  it("models targeted cohort switchback as bundle state, not restore text", async () => {
    const stages = await scenarioStages("targeted-cohort-switchback");

    // When: the Detox scenario is inspected.
    // Then: the switchback asserts reloaded bundle state instead of restore UI text.
    expect(stages).toEqual([
      "deploy numeric cohort bundle",
      "compute numeric rollout sample",
      "deploy qa cohort bundle",
      "enter numeric cohort",
      "apply numeric cohort",
      "assert numeric cohort applied",
      "install numeric cohort update",
      "wait numeric cohort metadata pending",
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
      "deploy current bundle",
      "install current bundle",
      "wait current bundle metadata pending",
      "reload current bundle",
      "wait current bundle metadata stable",
      "assert current bundle active",
      "disable current bundle",
      "install rollback to built-in",
      "reload to built-in",
      "assert metadata reset",
      "assert no crashed bundle",
    ]);
    expect(previousStages).toEqual([
      "deploy previous bundle",
      "install previous bundle",
      "wait previous bundle metadata pending",
      "reload previous bundle",
      "wait previous bundle metadata stable",
      "assert previous bundle active",
      "deploy next bundle",
      "install next bundle",
      "wait next bundle metadata pending",
      "reload next bundle",
      "wait next bundle metadata stable",
      "assert next bundle active",
      "disable next bundle",
      "install rollback to previous bundle",
      "wait previous rollback metadata pending",
      "reload previous bundle",
      "wait previous rollback metadata stable",
      "assert previous ota active",
    ]);
  });
});

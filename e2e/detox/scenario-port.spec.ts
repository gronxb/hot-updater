import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSuiteScenarioNames } from "../maestro/scenarios.ts";
import {
  detoxScenarioWaves,
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
  resolveDetoxSuiteScenarioNames,
} from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxRunnerPath = path.join(repoDir, "e2e/detox/scripts/run.ts");
const detoxJestSpecPath = path.join(repoDir, "e2e/detox/scenarios.spec.js");
const scenarioDir = path.join(repoDir, "e2e/detox/scenarios");
const exampleAppPath = path.join(repoDir, "examples/v0.85.0/App.tsx");

function scenarioStages(scenarioName: string): readonly string[] {
  return getDetoxScenarioDefinition(scenarioName).steps.map(
    (step) => step.stage,
  );
}

function controlStepBody(scenarioName: string, stage: string) {
  const step = getDetoxScenarioDefinition(scenarioName).steps.find(
    (entry) => entry.stage === stage,
  );
  if (!step || step.kind !== "control") {
    throw new Error(`Missing control step ${stage} in ${scenarioName}`);
  }
  return step.body ?? {};
}

function controlStepDefinition(scenarioName: string, stage: string) {
  const step = getDetoxScenarioDefinition(scenarioName).steps.find(
    (entry) => entry.stage === stage,
  );
  if (!step || step.kind !== "control") {
    throw new Error(`Missing control step ${stage} in ${scenarioName}`);
  }
  return step;
}

describe("Detox scenario port catalog", () => {
  it("ports the Maestro default suite names into Detox-owned waves", () => {
    // Given: Maestro default order remains the parity oracle.
    const maestroScenarios = resolveSuiteScenarioNames("default");

    // When: Detox exposes its own scenario catalog.
    const detoxScenarios = resolveDetoxSuiteScenarioNames("default");
    const waveScenarios = detoxScenarioWaves.flatMap((wave) => wave.scenarios);

    // Then: every default scenario is ported once in the same execution order.
    expect(detoxScenarios).toEqual(maestroScenarios);
    expect(waveScenarios).toEqual(maestroScenarios);
    expect(new Set(listDetoxScenarioNames()).size).toBe(14);
  });

  it("uses Detox-owned scenario lookup instead of importing the Maestro runner catalog", async () => {
    // Given: the CLI must run the ported Detox suite.
    const runnerSource = await fs.readFile(detoxRunnerPath, "utf8");

    // When: the runner resolves scenario names.
    const forbiddenImports = [
      "../../maestro/scenarios.ts",
      "resolveSuiteScenarioNames",
      "listAvailableScenarioNames",
    ];

    // Then: it uses the Detox catalog and keeps Maestro only as test oracle.
    for (const forbiddenImport of forbiddenImports) {
      expect(runnerSource).not.toContain(forbiddenImport);
    }
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

    // When: the ported scenario sources are inspected.
    const joinedSources = sources.join("\n");

    // Then: scenarios use testIDs and control stages without sleeps/retries.
    expect(joinedSources).toContain("action-install-current-channel-update");
    expect(joinedSources).toContain("cohort-input");
    expect(joinedSources).not.toMatch(/\bsleep\b|\bsetTimeout\b|\bretry\b/i);
  });

  it("executes every ported scenario through the Detox step runner", async () => {
    // Given: Detox CLI selects scenarios through Jest testNamePattern.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the ported scenario names are compared with the Jest suite.
    const scenarioNames = listDetoxScenarioNames();

    // Then: every scenario can be selected by the wrapper command.
    for (const scenarioName of scenarioNames) {
      expect(detoxJestSpec).toContain(`"${scenarioName}"`);
    }
    expect(detoxJestSpec).toContain("getDetoxScenarioDefinition");
    expect(detoxJestSpec).toContain("runScenarioStep");
    expect(detoxJestSpec).not.toContain(".todo");
  });

  it("emits a Jest testNamePattern that matches Detox full test names", () => {
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
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the Detox Jest lifecycle is inspected.
    // Then: remote bundles, app state, and Android reverse TCP forwarding are cleaned per scenario.
    expect(detoxJestSpec).toContain("device.reverseTcpPort");
    expect(detoxJestSpec).toContain("device.unreverseTcpPort");
    expect(detoxJestSpec).toContain("HOT_UPDATER_E2E_CONTROL_PORT");
    expect(detoxJestSpec).toContain("HOT_UPDATER_SERVER_PORT");
    expect(detoxJestSpec).toContain(
      "for (const port of androidReversePorts())",
    );
    expect(detoxJestSpec).toContain("device.terminateApp");
    expect(detoxJestSpec).toContain("/e2e/reset-remote-bundles");
    expect(detoxJestSpec).toContain("/e2e/reset-local-app-state");
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
    const launchIndex = beforeEachBody.indexOf("device.launchApp");

    // Then: launch keeps the freshly reset/seeded data instead of deleting it.
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(resetRemoteIndex).toBeGreaterThan(bootstrapIndex);
    expect(resetLocalIndex).toBeGreaterThan(resetRemoteIndex);
    expect(launchIndex).toBeGreaterThan(resetLocalIndex);
    expect(beforeEachBody).toContain("device.launchApp({ newInstance: true })");
    expect(beforeEachBody).not.toContain("delete: true");
  });

  it("keeps iOS read-only assertions on the active launch session", async () => {
    // Given: the foreground helper runs before every Detox UI assertion.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const foregroundBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function ensureAppForegroundForInteraction"),
      detoxJestSpec.indexOf("async function waitForTestID"),
    );

    // When: the helper foregrounds the app.
    // Then: only Android uses a Detox relaunch; iOS keeps transient launch reports intact.
    expect(foregroundBody).toContain("/e2e/ensure-app-foreground");
    expect(foregroundBody).toContain("device.sendToHome()");
    expect(foregroundBody).toContain(
      "if (isAndroidRun()) {\n    await device.sendToHome();\n    await device.launchApp({ newInstance: false });\n  }",
    );
    expect(foregroundBody).not.toMatch(
      /\}\s*await device\.launchApp\(\{ newInstance: false \}\);/,
    );
    expect(foregroundBody).not.toMatch(/\bretry\b/i);
    expect(foregroundBody).not.toContain("device.terminateApp");
    expect(detoxJestSpec).toContain("by.text(new RegExp");
  });

  it("lets control metadata prove install actions instead of waiting on busy UI text", () => {
    const installSteps = [
      ["release-ota-recovery", "install stable update"],
      ["release-ota-recovery", "install crash update"],
      ["bspatch-manifest-diff-fallback", "install manifest base update"],
      ["bspatch-manifest-diff-fallback", "install manifest fallback update"],
      ["runtime-channel-switch-reset", "install runtime channel update"],
      ["disabled-bundle-rollback-to-previous-ota", "install previous bundle"],
    ] as const;

    for (const [scenarioName, stage] of installSteps) {
      const step = getDetoxScenarioDefinition(scenarioName).steps.find(
        (entry) => entry.stage === stage,
      );

      expect(step).toMatchObject({
        kind: "tap",
        testID: expect.stringContaining("action-install-"),
      });
      expect(step).not.toHaveProperty("expectResultContains");
    }
  });

  it("keeps Detox synchronization disabled until the app is relaunched after install actions", async () => {
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const installTapBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function runTapStep"),
      detoxJestSpec.indexOf("async function runScenarioStep"),
    );
    const deviceActionBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function runDeviceAction"),
      detoxJestSpec.indexOf("async function runControlStep"),
    );
    const syncHelperBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function disableSynchronizationUntilLaunch"),
      detoxJestSpec.indexOf("async function runTapStep"),
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
    expect(deviceActionBody).toContain("markSynchronizationRestoredByLaunch()");
    expect(installTapBody).not.toMatch(/\bretry\b/i);
    expect(installTapBody).not.toMatch(/\bsetTimeout\b/i);
  });

  it("prefers the Detox control port over provider ports for host control traffic", async () => {
    // Given: dashboard split jobs set PORT/HOT_UPDATER_SERVER_PORT for the
    // provider update server and HOT_UPDATER_E2E_CONTROL_PORT for control.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the fallback control URL is inspected.
    const controlBaseUrlBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("function controlBaseUrl()"),
      detoxJestSpec.indexOf("function textFromAttributes"),
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
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the navigation target resolver is inspected.
    const launchStatusIndex = detoxJestSpec.indexOf(
      'testID === "launch-status-result"',
    );
    const genericResultIndex = detoxJestSpec.indexOf(
      'testID.endsWith("-result")',
    );

    // Then: the top-section special case must win before the generic result tab.
    expect(launchStatusIndex).toBeGreaterThan(-1);
    expect(launchStatusIndex).toBeLessThan(genericResultIndex);
  });

  it("routes action inputs to the actions section before generic runtime fields", async () => {
    // Given: runtime-channel-input is rendered under the Actions section.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the navigation target resolver is inspected.
    const inputIndex = detoxJestSpec.indexOf('testID.endsWith("-input")');
    const runtimeIndex = detoxJestSpec.indexOf('testID.startsWith("runtime-")');

    // Then: input fields must not be routed to the top section.
    expect(inputIndex).toBeGreaterThan(-1);
    expect(inputIndex).toBeLessThan(runtimeIndex);
  });

  it("scrolls inside the app content when Android layout offsets are not ready", async () => {
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const exampleAppSource = await fs.readFile(exampleAppPath, "utf8");
    const waitForTestIDBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function waitForTestID"),
      detoxJestSpec.indexOf("async function waitForVisibleText"),
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
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const tapBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("function shouldDisableSynchronizationForTap"),
      detoxJestSpec.indexOf("async function runDeviceAction"),
    );

    // When: tap handling is inspected.
    // Then: cohort/channel utility buttons keep normal synchronization.
    expect(tapBody).toContain("shouldDisableSynchronizationForTap");
    expect(tapBody).toContain('testID.startsWith("action-install-")');
    expect(tapBody).not.toContain(
      "await disableSynchronizationUntilLaunch();\n  await target.tap();",
    );
  });

  it("taps install actions directly and lets metadata jobs prove downloads", async () => {
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const tapBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function runTapStep"),
      detoxJestSpec.indexOf("async function runDeviceAction"),
    );

    expect(tapBody).not.toContain("waitForCurrentChannelDownload()");
    expect(detoxJestSpec).not.toContain(
      "function waitForCurrentChannelDownload",
    );
    expect(tapBody).toContain("await target.tap()");
    expect(tapBody).not.toMatch(/\bretry\b/i);
  });

  it("ports the target-cohorts-only pending verification and stable launch sequence", () => {
    // Given: Maestro verifies the pending bundle before reloading into stable.
    const stages = scenarioStages("target-cohorts-only");

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
      controlStepBody(
        "target-cohorts-only",
        "wait target cohort metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      controlStepBody(
        "target-cohorts-only",
        "wait target cohort metadata stable",
      ).verificationPending,
    ).toBe(false);
    expect(
      controlStepBody("target-cohorts-only", "deploy target cohort bundle")
        .rollout,
    ).toBe(0);
  });

  it("ports the force-update-auto-reload pending verification before stable launch", () => {
    // Given: Maestro observes the pending force-update before app restart.
    const stages = scenarioStages("force-update-auto-reload");

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
      controlStepBody(
        "force-update-auto-reload",
        "wait force update metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      controlStepBody(
        "force-update-auto-reload",
        "wait force update metadata stable",
      ).verificationPending,
    ).toBe(false);
  });

  it("ports the archive-to-diff OTA install and metadata verification sequence", () => {
    // Given: Maestro installs the archive OTA before asserting archive storage.
    const stages = scenarioStages("bspatch-archive-to-diff-ota");

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

  it("keeps archive-to-diff on the same default bundle profile as Maestro", () => {
    // Given: the Maestro parity flow does not set BUNDLE_PROFILE for archive-to-diff.
    const deployBody = controlStepBody(
      "bspatch-archive-to-diff-ota",
      "deploy archive base bundle",
    );

    // When: Detox ports the same deploy step.
    // Then: it must not opt into the separate archive300mb stress fixture.
    expect(deployBody.bundleProfile).toBeUndefined();
  });

  it("ports multi-asset replacement through stable first and second installs", () => {
    // Given: Maestro verifies each multi-asset OTA after a stable relaunch.
    const stages = scenarioStages("multi-asset-replacement");

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
      controlStepBody(
        "multi-asset-replacement",
        "wait first multi-asset metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      controlStepBody(
        "multi-asset-replacement",
        "wait first multi-asset metadata stable",
      ).verificationPending,
    ).toBe(false);
    expect(
      controlStepBody(
        "multi-asset-replacement",
        "wait second multi-asset metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      controlStepBody(
        "multi-asset-replacement",
        "wait second multi-asset metadata stable",
      ).verificationPending,
    ).toBe(false);
  });

  it("waits for consecutive bsdiff installs to become stable before asserting patch evidence", () => {
    // Given: Android and iOS use different primary bundle asset names.
    const stages = scenarioStages("bspatch-consecutive-diff-ota");
    const body = controlStepBody(
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

  it("ports manifest diff fallback through an installed previous bundle", () => {
    // Given: Maestro installs bundle A before asserting bundle C fallback.
    const stages = scenarioStages("bspatch-manifest-diff-fallback");

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

  it("ports release recovery without relaunching over recovered state", () => {
    const stages = scenarioStages("release-ota-recovery");

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
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");
    const reattachBody = detoxJestSpec.slice(
      detoxJestSpec.indexOf("async function reattachAfterExternalLaunch"),
      detoxJestSpec.indexOf("async function runControlStep"),
    );

    // When: the wait-for-crash-recovery control step completes.
    // Then: Android reconnects through Detox without adding a scenario-level relaunch.
    expect(reattachBody).toContain(
      'pathName !== "/e2e/wait-for-crash-recovery"',
    );
    expect(reattachBody).toContain("if (!isAndroidRun()) return;");
    expect(reattachBody).toContain(
      "await device.launchApp({ newInstance: false });",
    );
    expect(reattachBody).toContain("markSynchronizationRestoredByLaunch();");
    expect(reattachBody).not.toMatch(/\bretry\b/i);
    expect(scenarioStages("release-ota-recovery")).not.toContain(
      "launch recovered app",
    );
  });

  it("waits for cohort rollout metadata to become stable before active assertion", () => {
    const stages = scenarioStages("target-cohorts-rollout-interaction");

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
      controlStepBody(
        "target-cohorts-rollout-interaction",
        "wait cohort rollout metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      controlStepBody(
        "target-cohorts-rollout-interaction",
        "wait cohort rollout metadata stable",
      ).verificationPending,
    ).toBe(false);
  });

  it("ports runtime channel switching as an OTA state transition", () => {
    const stages = scenarioStages("runtime-channel-switch-reset");

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
      controlStepBody(
        "runtime-channel-switch-reset",
        "wait runtime channel metadata pending",
      ).verificationPending,
    ).toBe(true);
    expect(
      getDetoxScenarioDefinition("runtime-channel-switch-reset").steps.some(
        (step) => step.kind === "typeText",
      ),
    ).toBe(false);
  });

  it("ports numeric cohort rollout through an included rollout sample", () => {
    const stages = scenarioStages("numeric-cohort-rollout");

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
      controlStepDefinition("numeric-cohort-rollout", "compute rollout sample")
        .saveResultFieldsAs,
    ).toEqual({
      excludedCohort: "excludedCohort",
      includedCohort: "includedCohort",
    });
    expect(
      controlStepBody("numeric-cohort-rollout", "deploy numeric cohort bundle")
        .rollout,
    ).toBe(10);
    expect(
      controlStepBody("numeric-cohort-rollout", "deploy numeric cohort bundle")
        .safeBundleIds,
    ).toEqual(["$builtInBundleId"]);
    expect(
      controlStepBody("numeric-cohort-rollout", "wait rollout metadata pending")
        .verificationPending,
    ).toBe(true);
    expect(
      controlStepBody("numeric-cohort-rollout", "wait rollout metadata stable")
        .verificationPending,
    ).toBe(false);
  });

  it("ports targeted cohort switchback as bundle state, not restore text", () => {
    // Given: Maestro verifies numeric -> qa -> numeric bundle transitions.
    const stages = scenarioStages("targeted-cohort-switchback");

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

  it("ports disabled rollback scenarios through active OTA metadata before disabling", () => {
    // Given: rollback flows must first stabilize the OTA that will be disabled.
    const builtinStages = scenarioStages("disabled-bundle-rollback-to-builtin");
    const previousStages = scenarioStages(
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

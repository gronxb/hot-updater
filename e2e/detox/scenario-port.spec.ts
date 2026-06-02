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
    expect(joinedSources).toContain("runtime-channel-input");
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

  it("resets app state and Android host-port forwarding around each scenario", async () => {
    // Given: every scenario must start from clean app and network state.
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the Detox Jest lifecycle is inspected.
    // Then: app state and Android reverse TCP forwarding are cleaned per scenario.
    expect(detoxJestSpec).toContain("device.reverseTcpPort");
    expect(detoxJestSpec).toContain("device.unreverseTcpPort");
    expect(detoxJestSpec).toContain("device.terminateApp");
    expect(detoxJestSpec).toContain("delete: true");
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
      "assert target cohort install result",
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
      "deploy diff bundle",
      "assert archive diff bases",
      "launch archive diff app",
      "install archive diff update",
      "wait archive diff metadata pending",
      "reload archive diff update",
      "wait archive diff metadata stable",
      "assert archive diff patch",
    ]);
  });
});

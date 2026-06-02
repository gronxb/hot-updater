import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSuiteScenarioNames } from "../maestro/scenarios.ts";
import {
  detoxScenarioWaves,
  listDetoxScenarioNames,
  resolveDetoxSuiteScenarioNames,
} from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxRunnerPath = path.join(repoDir, "e2e/detox/scripts/run.ts");
const detoxJestSpecPath = path.join(repoDir, "e2e/detox/scenarios.spec.js");
const scenarioDir = path.join(repoDir, "e2e/detox/scenarios");

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
});

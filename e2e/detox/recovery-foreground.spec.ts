import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getDetoxScenarioDefinition } from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxJestSpecPath = path.join(repoDir, "e2e/detox/scenarios.spec.js");

describe("Detox recovery foreground handling", () => {
  it("keeps Android foreground recovery from relaunching before the recovered launch assertion", async () => {
    // Given: Android crash recovery relaunches the app outside Detox and the
    // recovered launch status is a one-shot UI value.
    const scenario = getDetoxScenarioDefinition("release-ota-recovery");
    const recoveredLaunchStep = scenario.steps.find(
      (step) => step.stage === "assert recovered stable launch",
    );
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the recovered stable launch text is asserted.
    // Then: that step opts out of the generic foreground relaunch path.
    expect(recoveredLaunchStep).toMatchObject({
      ensureForeground: false,
      kind: "assertText",
      testID: "launch-status-result",
    });
    expect(detoxJestSpec).toContain(
      "waitForTestID(step.testID, { ensureForeground: step.ensureForeground })",
    );
    expect(detoxJestSpec).toContain("if (options.ensureForeground !== false)");
  });

  it("asserts the native recovery report before reading the stable recovery UI", () => {
    // Given: Android can relaunch through the control server and report
    // RECOVERED before the React UI settles into the active stable bundle.
    const scenario = getDetoxScenarioDefinition("release-ota-recovery");
    const stages = scenario.steps.map((step) => step.stage);
    const recoveryIndex = stages.indexOf("wait crash recovery");
    const recoveredLaunchStep = scenario.steps.find(
      (step) => step.stage === "assert recovered stable launch",
    );

    // When: crash recovery is verified.
    // Then: the native launch report owns the transient RECOVERED assertion,
    // and UI text only checks the stable launch state after recovery.
    expect(stages.slice(recoveryIndex + 1, recoveryIndex + 3)).toEqual([
      "assert recovery launch report",
      "assert recovered stable launch",
    ]);
    expect(recoveredLaunchStep).toMatchObject({
      contains: "Current Launch Status: STABLE",
      ensureForeground: false,
      kind: "assertText",
      testID: "launch-status-result",
    });
  });
});

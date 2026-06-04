import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getDetoxScenarioDefinition } from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxJestSpecPath = path.join(repoDir, "e2e/detox/scenarios.spec.js");

describe("Detox recovery foreground handling", () => {
  it("uses native recovery evidence before reading recovered app UI", async () => {
    // Given: Android crash recovery relaunches the app outside Detox and the
    // launch status UI can be a transient platform-specific value.
    const scenario = getDetoxScenarioDefinition("release-ota-recovery");
    const recoveredLaunchStatusStep = scenario.steps.find(
      (step) => step.stage === "assert recovered stable launch",
    );
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: recovery is verified after the control-server relaunch.
    // Then: launch status is asserted through the native report, not UI text.
    expect(recoveredLaunchStatusStep).toBeUndefined();
    expect(detoxJestSpec).toContain(
      "waitForTestID(step.testID, { ensureForeground: step.ensureForeground })",
    );
    expect(detoxJestSpec).toContain("if (options.ensureForeground !== false)");
  });

  it("asserts the native recovery report before reading recovered bundle UI", () => {
    // Given: Android can relaunch through the control server and report
    // RECOVERED before the React UI settles into the active stable bundle.
    const scenario = getDetoxScenarioDefinition("release-ota-recovery");
    const stages = scenario.steps.map((step) => step.stage);
    const recoveryIndex = stages.indexOf("wait crash recovery");
    const recoveredBundleStep = scenario.steps.find(
      (step) => step.stage === "assert recovered bundle id",
    );

    // When: crash recovery is verified.
    // Then: the native launch report owns the transient RECOVERED assertion,
    // and UI text only checks durable recovered bundle evidence after recovery.
    expect(stages.slice(recoveryIndex + 1, recoveryIndex + 3)).toEqual([
      "assert recovery launch report",
      "assert recovered bundle id",
    ]);
    expect(recoveredBundleStep).toMatchObject({
      contains: "$stableBundleId",
      kind: "assertText",
      testID: "runtime-bundle-id",
    });
  });
});

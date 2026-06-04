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
      (step) => step.stage === "assert recovered launch",
    );
    const detoxJestSpec = await fs.readFile(detoxJestSpecPath, "utf8");

    // When: the recovered launch text is asserted.
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
});

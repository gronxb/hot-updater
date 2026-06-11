import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "./control-client.ts";
import { getDetoxScenarioDefinition } from "./scenarios.ts";
import type { DetoxAppDriver } from "./scenarios.ts";

const repoDir = path.resolve(import.meta.dirname, "../..");
const detoxPagePath = path.join(repoDir, "e2e/detox/detox-page.js");
const detoxScenarioRuntimePath = path.join(
  repoDir,
  "e2e/detox/detox-app-driver.js",
);

type RecordedRecoveryCall = {
  readonly body?: JsonObject;
  readonly kind: "assertText" | "control" | "device" | "tap" | "typeText";
  readonly stage: string;
  readonly testID?: string;
};

async function recordRecoveryCalls(): Promise<readonly RecordedRecoveryCall[]> {
  const calls: RecordedRecoveryCall[] = [];
  const app: DetoxAppDriver = {
    assertText: (stage, testID) => {
      calls.push({ kind: "assertText", stage, testID });
      return Promise.resolve();
    },
    control: (stage, _pathName, body) => {
      calls.push({ body, kind: "control", stage });
      return Promise.resolve();
    },
    launch: (stage) => {
      calls.push({ kind: "device", stage });
      return Promise.resolve();
    },
    reload: (stage) => {
      calls.push({ kind: "device", stage });
      return Promise.resolve();
    },
    resetAppState: (stage) => {
      calls.push({ kind: "device", stage });
      return Promise.resolve();
    },
    tap: (stage, testID) => {
      calls.push({ kind: "tap", stage, testID });
      return Promise.resolve();
    },
    terminate: (stage) => {
      calls.push({ kind: "device", stage });
      return Promise.resolve();
    },
    typeText: (stage, testID) => {
      calls.push({ kind: "typeText", stage, testID });
      return Promise.resolve();
    },
  };
  await getDetoxScenarioDefinition("release-ota-recovery").run(app);
  return calls;
}

async function recoveryStages(): Promise<readonly string[]> {
  return (await recordRecoveryCalls()).map((call) => call.stage);
}

describe("Detox recovery foreground handling", () => {
  it("uses native recovery evidence before reading recovered app UI", async () => {
    // Given: Android crash recovery relaunches the app outside Detox and the
    // launch status UI can be a transient platform-specific value.
    const stages = await recoveryStages();
    const hasRecoveredLaunchStatusStage = stages.includes(
      "assert recovered stable launch",
    );
    const detoxPageSource = await fs.readFile(detoxPagePath, "utf8");
    const detoxScenarioRuntimeSource = await fs.readFile(
      detoxScenarioRuntimePath,
      "utf8",
    );

    // When: recovery is verified after the control-server relaunch.
    // Then: launch status is asserted through the native report, not UI text.
    expect(hasRecoveredLaunchStatusStage).toBe(false);
    expect(detoxScenarioRuntimeSource).toContain(
      "findVisibleTestID(this.controlClient, testID, {",
    );
    expect(detoxScenarioRuntimeSource).toContain(
      "ensureForeground: options.ensureForeground",
    );
    expect(detoxPageSource).toContain(
      "if (options.ensureForeground !== false)",
    );
  });

  it("asserts the native recovery report before reading recovered bundle UI", async () => {
    // Given: Android can relaunch through the control server and report
    // RECOVERED before the React UI settles into the active stable bundle.
    const calls = await recordRecoveryCalls();
    const stages = calls.map((call) => call.stage);
    const recoveryIndex = stages.indexOf("wait crash recovery");
    const recoveredBundleCall = calls.find(
      (call) => call.stage === "assert recovered bundle id",
    );

    // When: crash recovery is verified.
    // Then: the native launch report owns the transient RECOVERED assertion,
    // and UI text only checks durable recovered bundle evidence after recovery.
    expect(stages.slice(recoveryIndex + 1, recoveryIndex + 3)).toEqual([
      "assert recovery launch report",
      "assert recovered bundle id",
    ]);
    expect(recoveredBundleCall).toMatchObject({
      kind: "assertText",
      testID: "runtime-bundle-id",
    });
  });

  it("passes the stable bundle id into the recovery launch report assertion", async () => {
    const calls = await recordRecoveryCalls();

    expect(
      calls.find((call) => call.stage === "assert recovery launch report"),
    ).toMatchObject({
      body: {
        crashedBundleId: "$crashBundleId",
        stableBundleId: "$stableBundleId",
        status: "RECOVERED",
      },
      kind: "control",
    });
  });

  it("uses crash history instead of transient crashed-bundle UI text", async () => {
    // Given: the recovered UI can clear the transient crashed bundle text.
    const calls = await recordRecoveryCalls();
    const stages = calls.map((call) => call.stage);
    const crashHistoryIndex = stages.indexOf("assert crash history");
    const metadataIndex = stages.indexOf("assert recovered metadata active");

    // When: recovery evidence is asserted after the native launch report.
    // Then: durable crash history owns the crashedBundleId assertion.
    expect(stages).not.toContain("assert crashed bundle result");
    expect(
      calls.some(
        (call) =>
          call.kind === "assertText" &&
          call.testID === "launch-crashed-bundle-result",
      ),
    ).toBe(false);
    expect(crashHistoryIndex).toBeGreaterThan(metadataIndex);
  });
});

import { describe, expect, it } from "vitest";

import type { JsonObject } from "./control-client.ts";
import { getScenarioDefinition } from "./scenarios.ts";
import type { ScenarioAppDriver } from "./scenarios.ts";

type RecordedRecoveryCall = {
  readonly body?: JsonObject;
  readonly kind: "assertText" | "control" | "device" | "tap" | "typeText";
  readonly options?: { readonly expectCrash?: boolean };
  readonly stage: string;
  readonly testID?: string;
};

async function recordRecoveryCalls(
  scenario: Parameters<
    typeof getScenarioDefinition
  >[0] = "release-ota-recovery",
): Promise<readonly RecordedRecoveryCall[]> {
  const calls: RecordedRecoveryCall[] = [];
  const app: ScenarioAppDriver = {
    assertText: (stage, testID) => {
      calls.push({ kind: "assertText", stage, testID });
      return Promise.resolve();
    },
    control: (stage, _pathName, body) => {
      calls.push({ body, kind: "control", stage });
      return Promise.resolve();
    },
    launch: (stage, options) => {
      calls.push({ kind: "device", options, stage });
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
  await getScenarioDefinition(scenario).run(app);
  return calls;
}

async function recoveryStages(): Promise<readonly string[]> {
  return (await recordRecoveryCalls()).map((call) => call.stage);
}

describe("Native recovery foreground handling", () => {
  it.each([
    ["release-ota-recovery", "launch crash bundle"],
    ["crash-then-next-safe-update", "launch next-safe crash Bundle"],
    ["runtime-channel-crash-restore", "launch beta crash Bundle"],
    ["republished-crashed-bundle-skipped", "launch republished crash Bundle"],
  ] as const)(
    "marks only the installed crashing bundle launch in %s",
    async (scenario, crashStage) => {
      const calls = await recordRecoveryCalls(scenario);
      expect(calls.filter((call) => call.options?.expectCrash)).toEqual([
        { kind: "device", options: { expectCrash: true }, stage: crashStage },
      ]);
    },
  );

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
        fromBundleId: "$crashBundleId",
        fromReleaseId: "$crashReleaseId",
        status: "RECOVERED",
        toBundleId: "$stableBundleId",
        toReleaseId: "$stableReleaseId",
      },
      kind: "control",
    });
  });

  it("uses the native report and crash history instead of transient recovery UI", async () => {
    // Given: the recovered UI can clear the transient crashed bundle text.
    const calls = await recordRecoveryCalls();
    const stages = calls.map((call) => call.stage);
    const crashHistoryIndex = stages.indexOf("assert crash history");
    const metadataIndex = stages.indexOf("assert recovered metadata active");

    // When: recovery evidence is asserted after the native launch report.
    // Then: directional launch state comes from the exact native report and
    // durable crash history is checked after the restored receipt.
    expect(stages).not.toContain("assert crashed bundle result");
    expect(stages).not.toContain("assert recovered directional transition");
    expect(
      calls.find((call) => call.stage === "assert recovery launch report"),
    ).toMatchObject({ kind: "control" });
    expect(crashHistoryIndex).toBeGreaterThan(metadataIndex);
  });
});

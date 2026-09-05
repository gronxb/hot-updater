import fs from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";

import { describe, expect, it, vi } from "vitest";

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
  it.each([
    { platform: "ios", stage: "launch crash bundle", synchronization: 0 },
    {
      platform: "ios",
      stage: "launch stable bundle",
      synchronization: undefined,
    },
    {
      platform: "android",
      stage: "launch crash bundle",
      synchronization: undefined,
    },
  ])(
    "sets launch synchronization before $platform $stage",
    async ({ platform, stage, synchronization }) => {
      const [pageSource, driverSource] = await Promise.all([
        fs.readFile(detoxPagePath, "utf8"),
        fs.readFile(detoxScenarioRuntimePath, "utf8"),
      ]);
      const calls: string[] = [];
      const device = {
        launchApp: vi.fn(async () => {
          calls.push("launch");
        }),
      };
      const controlClient = {
        postJson: vi.fn(async () => {
          calls.push("prepare");
          return {};
        }),
      };
      const pageModule = { exports: {} };
      new Script(pageSource).runInNewContext({
        module: pageModule,
        process: {
          env: {
            HOT_UPDATER_E2E_PLATFORM: platform,
            HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
              "http://localhost:3107/e2e/runtime-config",
            HOT_UPDATER_E2E_APP_BASE_URL: "http://localhost:3007/hot-updater",
          },
        },
        require: (name: string) => (name === "detox" ? { device } : {}),
      });
      const driver = new Script(
        `${driverSource}\nnew module.exports.DetoxAppDriver(controlClient);`,
      ).runInNewContext({
        module: { exports: {} },
        controlClient,
        require: (name: string) =>
          name === "detox" ? { device } : pageModule.exports,
      }) as { launch: (stage: string) => Promise<void> };

      await driver.launch(stage);

      expect(calls).toEqual(["prepare", "launch"]);
      expect(controlClient.postJson).toHaveBeenCalledWith(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      expect(device.launchApp).toHaveBeenCalledWith({
        newInstance: true,
        launchArgs: {
          HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
            "http://localhost:3107/e2e/runtime-config",
          HOT_UPDATER_APP_BASE_URL: "http://localhost:3007/hot-updater",
          ...(synchronization === undefined
            ? {}
            : { detoxEnableSynchronization: synchronization }),
        },
      });
      if (synchronization === 0) {
        await driver.launch("launch stable bundle");
        expect(device.launchApp).toHaveBeenLastCalledWith({
          newInstance: true,
          launchArgs: {
            HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
              "http://localhost:3107/e2e/runtime-config",
            HOT_UPDATER_APP_BASE_URL: "http://localhost:3007/hot-updater",
          },
        });
      }
    },
  );

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

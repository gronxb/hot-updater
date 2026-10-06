import { test as mobileTest } from "@e2e-dev/mobile";

import { createControlClient } from "../shared/control-client.ts";
import type { ControlClient, JsonObject } from "../shared/control-client.ts";
import { getScenarioDefinition } from "../shared/scenarios.ts";
import { writeAttemptRecord } from "./attempt.ts";
import type { ScenarioEvidence } from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { MobileAppDriver } from "./driver.ts";
import { createIosAlertReader } from "./ios-alert.ts";

const context = readMobileContext();
const evidence: ScenarioEvidence[] = [];
const cleanupEvidence: { name: string | null; cleanupCompleted: true }[] = [];
let installed = false;

interface HotUpdaterAttempt {
  readonly client: ControlClient;
  readonly controller: AbortController;
  bootstrap: JsonObject;
  name?: string;
  consoleInsights?: JsonObject;
  expectedLaunchFailures?: number;
}

const test = mobileTest.extend<{ hotUpdater: HotUpdaterAttempt }>({
  hotUpdater: async (_fixtures, use) => {
    // The runner abandons a timed-out body instead of cancelling it. Aborting
    // here fences its later continuations from the controller and the device.
    const controller = new AbortController();
    const client = createControlClient({
      baseUrl: context.controlBaseUrl,
      signal: controller.signal,
      onStageTiming: (timing) =>
        console.log(`[e2e-stage:timing] ${JSON.stringify(timing)}`),
    });
    try {
      await use({ client, controller, bootstrap: {} });
    } finally {
      controller.abort(new Error("Scenario attempt finished"));
    }
  },
});

test.beforeEach(async ({ device, hotUpdater }) => {
  // The engine installs nothing on its own: the run's build goes on the device
  // once, before any bootstrap, reset, or app launch.
  if (!installed) {
    await device.installApp();
    installed = true;
  }
  hotUpdater.bootstrap = await hotUpdater.client.runJob(
    "bootstrap",
    "/e2e/jobs/bootstrap",
    { deviceId: context.deviceId },
  );
  await hotUpdater.client.runJob(
    "reset remote bundles",
    "/e2e/jobs/reset-remote-bundles",
    {},
  );
  await hotUpdater.client.postJson(
    "reset local app state",
    "/e2e/reset-local-app-state",
    {},
  );
});

// Runs after a failed setup or body too, before the fixture's teardown.
test.afterEach(async ({ hotUpdater }) => {
  hotUpdater.controller.abort(new Error("Scenario attempt finished"));
  try {
    // Leave room inside the SDK hook budget for device/session shutdown.
    await hotUpdater.client.cancelAndDrain({
      timeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    });
    // The attempt client is aborted after draining. Terminate through the
    // owned controller's explicit device; SDK disposal closes its session.
    await createControlClient({
      baseUrl: context.controlBaseUrl,
      httpTimeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    }).postJson("terminate app after attempt", "/e2e/terminate-app", {});
  } catch (error) {
    writeAttemptRecord(context.resultsDir, "quarantine.json", {
      schemaVersion: 1,
      scenarioName: hotUpdater.name ?? null,
      reason: String(error),
      quarantineRequired: true,
    });
    throw error;
  }
  cleanupEvidence.push({
    name: hotUpdater.name ?? null,
    cleanupCompleted: true,
  });
  writeAttemptRecord(context.resultsDir, "cleanup-evidence.json", {
    schemaVersion: 1,
    attempts: cleanupEvidence,
  });
  if (hotUpdater.name && hotUpdater.consoleInsights) {
    evidence.push({
      name: hotUpdater.name,
      consoleInsights: hotUpdater.consoleInsights,
      expectedLaunchFailures: hotUpdater.expectedLaunchFailures ?? 0,
      bodyCompleted: true,
      cleanupCompleted: true,
    });
    writeAttemptRecord(context.resultsDir, "scenario-evidence.json", {
      schemaVersion: 1,
      scenarios: evidence,
    });
  }
});

for (const scenarioName of context.scenarioNames) {
  const scenario = getScenarioDefinition(scenarioName);
  test(scenarioName, async ({ device, screen, hotUpdater }) => {
    hotUpdater.name = scenarioName;
    const { signal } = hotUpdater.controller;
    let iosAlert: ReturnType<typeof createIosAlertReader> | undefined;
    const app = new MobileAppDriver({
      appId: context.appId,
      client: hotUpdater.client,
      device,
      iosAlert: {
        get: () => (iosAlert ??= createIosAlertReader(context, signal)).get(),
      },
      initialValues: hotUpdater.bootstrap,
      platform: context.platform,
      screen,
      signal,
    });
    const insightsStartedAtMs = Date.now() - 5_000;
    await scenario.run(app);
    hotUpdater.consoleInsights =
      await app.verifyConsoleInsights(insightsStartedAtMs);
    hotUpdater.expectedLaunchFailures = app.expectedLaunchFailures;
  });
}

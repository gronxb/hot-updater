import { randomUUID } from "node:crypto";

import { test as mobileTest } from "@e2e-dev/mobile";

import { createControlClient } from "../shared/control-client.ts";
import type { ControlClient, JsonObject } from "../shared/control-client.ts";
import { getScenarioDefinition } from "../shared/scenarios.ts";
import { recordAttempt, recordQuarantine } from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { MobileAppDriver } from "./driver.ts";
import { createIosAlertReader } from "./ios-alert.ts";

const context = readMobileContext();
let installed = false;

interface HotUpdaterAttempt {
  readonly client: ControlClient;
  readonly signal: AbortSignal;
  name?: string;
  bootstrap: JsonObject;
  consoleInsights?: JsonObject;
  expectedLaunchFailures?: number;
}

async function finishAttempt(attempt: HotUpdaterAttempt) {
  const key = attempt.name ?? randomUUID();
  try {
    // Leave room inside the SDK teardown budget for device/session shutdown.
    await attempt.client.cancelAndDrain({
      timeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    });
    // The attempt client is fenced after draining. Terminate through the
    // owned controller's explicit device; SDK disposal closes its session.
    await createControlClient({
      baseUrl: context.controlBaseUrl,
      httpTimeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    }).postJson("terminate app after attempt", "/e2e/terminate-app", {});
  } catch (error) {
    recordQuarantine(context.resultsDir, key, {
      schemaVersion: 1,
      scenarioName: attempt.name ?? null,
      reason: String(error),
      quarantineRequired: true,
    });
    throw error;
  }
  recordAttempt(context.resultsDir, key, {
    schemaVersion: 1,
    name: attempt.name ?? null,
    cleanupCompleted: true,
    ...(attempt.consoleInsights
      ? {
          consoleInsights: attempt.consoleInsights,
          expectedLaunchFailures: attempt.expectedLaunchFailures ?? 0,
        }
      : {}),
  });
}

const test = mobileTest.extend<{ hotUpdater: HotUpdaterAttempt }>({
  hotUpdater: async (_fixtures, use) => {
    // A timeout abandons the body; its next SDK step fails as CANCELLED, and
    // aborting here once it is torn down fences its control-plane calls.
    const controller = new AbortController();
    const attempt: HotUpdaterAttempt = {
      client: createControlClient({
        baseUrl: context.controlBaseUrl,
        signal: controller.signal,
        onStageTiming: (timing) =>
          console.log(`[e2e-stage:timing] ${JSON.stringify(timing)}`),
      }),
      signal: controller.signal,
      bootstrap: {},
    };
    await use(attempt);
    // Runs after the hooks and the body, whether or not they failed.
    controller.abort(new Error("Scenario attempt finished"));
    await finishAttempt(attempt);
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

for (const scenarioName of context.scenarioNames) {
  const scenario = getScenarioDefinition(scenarioName);
  test(scenarioName, async ({ device, screen, hotUpdater }) => {
    hotUpdater.name = scenarioName;
    const app = new MobileAppDriver({
      appId: context.appId,
      client: hotUpdater.client,
      device,
      iosAlert: createIosAlertReader(context, hotUpdater.signal),
      initialValues: hotUpdater.bootstrap,
      platform: context.platform,
      screen,
      signal: hotUpdater.signal,
    });
    const insightsStartedAtMs = Date.now() - 5_000;
    await scenario.run(app);
    hotUpdater.consoleInsights =
      await app.verifyConsoleInsights(insightsStartedAtMs);
    hotUpdater.expectedLaunchFailures = app.expectedLaunchFailures;
  });
}

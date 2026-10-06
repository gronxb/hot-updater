import { test as mobileTest } from "@e2e-dev/mobile";

import { LynxAppDriver } from "../lynx/lynx-app-driver.ts";
import { getLynxScenarioDefinition } from "../lynx/scenarios.ts";
import { createControlClient } from "../shared/control-client.ts";
import type { ControlClient, JsonObject } from "../shared/control-client.ts";
import { getScenarioDefinition } from "../shared/scenarios.ts";
import {
  runAttemptPhase,
  runtimeLaunchArguments,
  writeAttemptRecord,
} from "./attempt.ts";
import type { ScenarioEvidence } from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { MobileAppDriver } from "./driver.ts";
import type { IosAlert } from "./ios-alert.ts";

const context = readMobileContext();
const test = mobileTest.extend<{
  hotUpdaterAttemptSignal: { signal: AbortSignal };
  hotUpdaterIosAlert: { get(): Promise<IosAlert | null> };
}>();
const evidence: ScenarioEvidence[] = [];
const cleanupEvidence: { name: string | null; cleanupCompleted: true }[] = [];
let installed = false;
let attempt:
  | {
      controller: AbortController;
      signal: AbortSignal;
      client: ControlClient;
      bootstrap: JsonObject;
      name?: string;
      consoleInsights?: JsonObject;
      expectedLaunchFailures?: number;
    }
  | undefined;

test.beforeEach(async ({ device, hotUpdaterAttemptSignal }) => {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    hotUpdaterAttemptSignal.signal,
  ]);
  const client = createControlClient({
    baseUrl: context.controlBaseUrl,
    signal,
    onStageTiming: (timing) =>
      console.log(`[e2e-stage:timing] ${JSON.stringify(timing)}`),
  });
  attempt = { controller, signal, client, bootstrap: {} };
  const current = attempt;
  await runAttemptPhase(
    "setup",
    context.setupTimeoutMs,
    controller,
    signal,
    async () => {
      // Suite hooks receive no device fixture in e2e@0.16.0. Installation belongs
      // to the first attempt, before bootstrap, reset, or any app launch.
      if (!installed) {
        await device.installApp(context.appPath, { app: context.appId });
        installed = true;
      }
      current.bootstrap = await client.runJob(
        "bootstrap",
        "/e2e/jobs/bootstrap",
        { deviceId: context.deviceId },
      );
      await client.runJob(
        "reset remote bundles",
        "/e2e/jobs/reset-remote-bundles",
        {},
      );
      await client.postJson(
        "reset local app state",
        "/e2e/reset-local-app-state",
        {},
      );
    },
  );
});

test.afterEach(async () => {
  const current = attempt;
  if (!current) return;
  current.controller.abort(new Error("Scenario attempt finished"));
  try {
    // Leave room inside the SDK hook budget for device/session shutdown.
    await current.client.cancelAndDrain({
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
      scenarioName: current.name ?? null,
      reason: String(error),
      quarantineRequired: true,
    });
    throw error;
  } finally {
    attempt = undefined;
  }
  cleanupEvidence.push({ name: current.name ?? null, cleanupCompleted: true });
  writeAttemptRecord(context.resultsDir, "cleanup-evidence.json", {
    schemaVersion: 1,
    attempts: cleanupEvidence,
  });
  if (current.name && current.consoleInsights) {
    evidence.push({
      name: current.name,
      consoleInsights: current.consoleInsights,
      expectedLaunchFailures: current.expectedLaunchFailures ?? 0,
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
  test(scenarioName, async ({ device, screen, hotUpdaterIosAlert }) => {
    const current = attempt;
    if (!current) throw new Error("Scenario setup did not complete");
    current.name = scenarioName;
    await runAttemptPhase(
      "scenario",
      context.scenarioTimeoutMs,
      current.controller,
      current.signal,
      async () => {
        // The shared controller outlives each scenario; process environment
        // cannot select runtime behavior for individual attempts.
        await current.client.postJson(
          "configure scenario runtime",
          "/e2e/runtime-config",
          { automaticForceUpdate: scenarioName === "force-update-auto-reload" },
        );
        const insightsStartedAtMs = Date.now() - 5_000;
        if (context.runtime === "lynx") {
          const app = new LynxAppDriver(
            current.client,
            context.platform,
            process.env,
            current.bootstrap,
            { device, screen, signal: current.signal },
          );
          await getLynxScenarioDefinition(scenarioName).run(app);
          current.consoleInsights =
            await app.verifyConsoleInsights(insightsStartedAtMs);
          current.expectedLaunchFailures = app.expectedLaunchFailures;
          writeAttemptRecord(
            context.resultsDir,
            `lynx-generation-ledger-${scenarioName}.json`,
            app.runtimeEventLedgerReceipt(),
          );
          return;
        }
        const app = new MobileAppDriver({
          appId: context.appId,
          client: current.client,
          device,
          iosAlert: hotUpdaterIosAlert,
          initialValues: current.bootstrap,
          launchArguments: runtimeLaunchArguments(context.platform),
          platform: context.platform,
          screen,
          signal: current.signal,
        });
        await getScenarioDefinition(scenarioName).run(app);
        current.consoleInsights =
          await app.verifyConsoleInsights(insightsStartedAtMs);
        current.expectedLaunchFailures = app.expectedLaunchFailures;
      },
    );
  });
}

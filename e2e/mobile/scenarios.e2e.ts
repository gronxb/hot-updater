import { test as mobileTest } from "@e2e-dev/mobile";

import { LynxAppDriver } from "../lynx/lynx-app-driver.ts";
import { getLynxScenarioDefinition } from "../lynx/scenarios.ts";
import { createControlClient } from "../shared/control-client.ts";
import { getScenarioDefinition } from "../shared/scenarios.ts";
import {
  finishAttempt,
  type HotUpdaterAttempt,
  writeAttemptRecord,
} from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { MobileAppDriver } from "./driver.ts";
import { createIosAlertReader } from "./ios-alert.ts";

const context = readMobileContext();
let installed = false;

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
    await finishAttempt(attempt, context);
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
  test(scenarioName, async ({ device, screen, hotUpdater }) => {
    hotUpdater.name = scenarioName;
    await hotUpdater.client.postJson(
      "configure scenario runtime",
      "/e2e/runtime-config",
      { automaticForceUpdate: scenarioName === "force-update-auto-reload" },
    );
    const insightsStartedAtMs = Date.now() - 5_000;
    if (context.runtime === "lynx") {
      const app = new LynxAppDriver(
        hotUpdater.client,
        context.platform,
        process.env,
        hotUpdater.bootstrap,
        { device, screen, signal: hotUpdater.signal },
      );
      await getLynxScenarioDefinition(scenarioName).run(app);
      hotUpdater.consoleInsights =
        await app.verifyConsoleInsights(insightsStartedAtMs);
      hotUpdater.expectedLaunchFailures = app.expectedLaunchFailures;
      writeAttemptRecord(
        context.resultsDir,
        `lynx-generation-ledger-${scenarioName}.json`,
        app.runtimeEventLedgerReceipt(),
      );
      return;
    }
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
    await getScenarioDefinition(scenarioName).run(app);
    hotUpdater.consoleInsights =
      await app.verifyConsoleInsights(insightsStartedAtMs);
    hotUpdater.expectedLaunchFailures = app.expectedLaunchFailures;
  });
}

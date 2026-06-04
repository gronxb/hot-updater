const {
  by,
  device,
  element,
  expect: detoxExpect,
  waitFor,
} = require("detox");

const scenarioNames = [
  "release-ota-recovery",
  "multi-asset-replacement",
  "bspatch-archive-to-diff-ota",
  "bspatch-consecutive-diff-ota",
  "bspatch-disabled-chain-rollback",
  "bspatch-manifest-diff-fallback",
  "runtime-channel-switch-reset",
  "numeric-cohort-rollout",
  "target-cohorts-only",
  "target-cohorts-rollout-interaction",
  "targeted-cohort-switchback",
  "force-update-auto-reload",
  "disabled-bundle-rollback-to-builtin",
  "disabled-bundle-rollback-to-previous-ota",
];

let createControlClient;
let getDetoxScenarioDefinition;
let controlClient;
let stageValues;
let synchronizationDisabledUntilLaunch = false;

function isAndroidRun() {
  return [
    process.env.DETOX_CONFIGURATION,
    process.env.HOT_UPDATER_E2E_PLATFORM,
  ].some((value) => value?.toLowerCase().includes("android"));
}

function androidReversePorts() {
  return [
    process.env.HOT_UPDATER_E2E_CONTROL_PORT,
    process.env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT,
    process.env.HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT,
    process.env.HOT_UPDATER_SERVER_PORT,
    process.env.PORT,
  ]
    .map((value) => Number.parseInt(value || "", 10))
    .filter((value) => Number.isInteger(value) && value > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function controlBaseUrl() {
  if (process.env.CONTROL_URL) return process.env.CONTROL_URL;
  if (process.env.HOT_UPDATER_E2E_CONTROL_BASE_URL) {
    return process.env.HOT_UPDATER_E2E_CONTROL_BASE_URL;
  }
  const port =
    process.env.HOT_UPDATER_E2E_CONTROL_PORT ||
    process.env.PORT ||
    process.env.HOT_UPDATER_SERVER_PORT ||
    "3107";
  return `http://127.0.0.1:${port}`;
}

function textFromAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return "";
  for (const field of ["text", "label", "value"]) {
    if (typeof attributes[field] === "string") return attributes[field];
  }
  if (Array.isArray(attributes.elements)) {
    return attributes.elements.map(textFromAttributes).filter(Boolean).join("\n");
  }
  return "";
}

function readStageValue(key) {
  if (Object.hasOwn(stageValues, key)) return stageValues[key];
  throw new Error(`Missing Detox scenario value: ${key}`);
}

function resolvePlaceholders(value) {
  if (typeof value === "string") {
    if (value.startsWith("$") && value.indexOf("$", 1) === -1) {
      return readStageValue(value.slice(1));
    }
    return value.replace(/\$([A-Za-z0-9_]+)/g, (_, key) =>
      String(readStageValue(key)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolvePlaceholders(item),
      ]),
    );
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function saveControlResult(saveResultAs, saveResultFieldsAs, result) {
  for (const [key, value] of Object.entries(result)) {
    stageValues[key] = value;
  }
  for (const [sourceKey, targetKey] of Object.entries(
    saveResultFieldsAs || {},
  )) {
    if (Object.hasOwn(result, sourceKey)) {
      stageValues[targetKey] = result[sourceKey];
    }
  }
  if (!saveResultAs) return;
  if (typeof result[saveResultAs] === "string") {
    stageValues[saveResultAs] = result[saveResultAs];
    return;
  }
  if (typeof result.bundleId === "string") {
    stageValues[saveResultAs] = result.bundleId;
    return;
  }
  if (typeof result.builtInBundleId === "string") {
    stageValues[saveResultAs] = result.builtInBundleId;
  }
}

function navTargetForTestID(testID) {
  if (testID.startsWith("action-set-") || testID === "action-restore-initial-cohort") {
    return "e2e-nav-cohort-actions";
  }
  if (testID.startsWith("action-") || testID.endsWith("-input")) {
    return "e2e-nav-actions";
  }
  if (
    testID === "launch-status-result" ||
    testID === "launch-crashed-bundle-result" ||
    testID === "current-channel-summary" ||
    testID === "current-cohort-summary" ||
    testID === "update-store-downloaded" ||
    testID === "update-store-download-paths" ||
    testID.startsWith("runtime-")
  ) {
    return "e2e-nav-top";
  }
  if (testID.endsWith("-result")) {
    return "e2e-nav-action-results";
  }
  if (testID === "crash-history-summary") {
    return "e2e-nav-crash-history";
  }
  return "e2e-nav-top";
}

async function navigateToTestID(testID) {
  const navTarget = navTargetForTestID(testID);
  await waitFor(element(by.id(navTarget))).toBeVisible().withTimeout(30000);
  await element(by.id(navTarget)).tap();
}

async function ensureAppForegroundForInteraction() {
  await controlClient.postJson(
    "ensure app foreground",
    "/e2e/ensure-app-foreground",
    {},
  );
  if (isAndroidRun()) {
    await device.sendToHome();
    await device.launchApp({ newInstance: false });
  }
}

async function waitForTestID(testID, options = {}) {
  if (options.ensureForeground !== false) await ensureAppForegroundForInteraction();
  await navigateToTestID(testID);
  const target = element(by.id(testID));
  await waitFor(target)
    .toBeVisible()
    .whileElement(by.id("e2e-scroll-content"))
    .scroll(260, "down");
  await waitFor(target).toBeVisible().withTimeout(30000);
  return target;
}

async function waitForVisibleText(testID, contains) {
  await navigateToTestID(testID);
  const expectedText = String(resolvePlaceholders(contains));
  const target = element(
    by.id(testID).and(by.text(new RegExp(escapeRegExp(expectedText)))),
  );
  await waitFor(target).toBeVisible().withTimeout(30000);
  const text = textFromAttributes(await target.getAttributes());
  if (!text.includes(expectedText)) {
    throw new Error(
      `${testID} expected to contain "${expectedText}", received "${text}"`,
    );
  }
}

async function disableSynchronizationUntilLaunch() {
  if (synchronizationDisabledUntilLaunch) return;
  await device.disableSynchronization();
  synchronizationDisabledUntilLaunch = true;
}

function shouldDisableSynchronizationForTap(testID) {
  return testID.startsWith("action-install-");
}

function markSynchronizationRestoredByLaunch() {
  synchronizationDisabledUntilLaunch = false;
}

async function reattachAfterExternalLaunch(pathName) {
  if (!isAndroidRun()) return;
  if (pathName !== "/e2e/wait-for-crash-recovery") return;
  await device.launchApp({ newInstance: false });
  markSynchronizationRestoredByLaunch();
}

async function runTapStep(step) {
  const target = await waitForTestID(step.testID);
  if (shouldDisableSynchronizationForTap(step.testID)) {
    await disableSynchronizationUntilLaunch();
  }
  await target.tap();
}

async function runDeviceAction(step) {
  if (step.action === "terminate") {
    await device.terminateApp();
    return;
  }
  if (step.action === "resetAppState") {
    await controlClient.postJson(
      `${step.stage}: reset local app state`,
      "/e2e/reset-local-app-state",
      {},
    );
    await device.launchApp({ newInstance: true });
    markSynchronizationRestoredByLaunch();
    return;
  }
  if (step.action === "reload") {
    await device.terminateApp();
    await device.launchApp({ newInstance: true });
    markSynchronizationRestoredByLaunch();
    return;
  }
  await controlClient.postJson(`${step.stage}: prepare launch`, "/e2e/prepare-app-launch", {});
  try {
    await device.launchApp({ newInstance: true });
    markSynchronizationRestoredByLaunch();
  } catch (error) {
    if (!step.stage.toLowerCase().includes("crash")) throw error;
  }
}

async function runControlStep(step) {
  const body = resolvePlaceholders(step.body);
  const runner = step.pathName.startsWith("/e2e/jobs/")
    ? controlClient.runJob.bind(controlClient)
    : controlClient.postJson.bind(controlClient);
  const result = await runner(step.stage, step.pathName, body);
  saveControlResult(step.saveResultAs, step.saveResultFieldsAs, result);
  await reattachAfterExternalLaunch(step.pathName);
}

async function runScenarioStep(step) {
  console.log(`[detox-stage:start] ${step.stage}`);
  if (step.kind === "control") {
    await runControlStep(step);
  } else if (step.kind === "device") {
    await runDeviceAction(step);
  } else if (step.kind === "tap") {
    await runTapStep(step);
  } else if (step.kind === "typeText") {
    await (await waitForTestID(step.testID)).replaceText(
      String(resolvePlaceholders(step.text)),
    );
  } else if (step.kind === "assertText") {
    const target = await waitForTestID(step.testID, { ensureForeground: step.ensureForeground });
    await detoxExpect(target).toBeVisible();
    const text = textFromAttributes(await target.getAttributes());
    const expectedText = String(resolvePlaceholders(step.contains));
    if (!text.includes(expectedText)) {
      throw new Error(
        `${step.stage} expected ${step.testID} to contain "${expectedText}", received "${text}"`,
      );
    }
  } else {
    throw new Error(`Unsupported Detox scenario step: ${step.kind}`);
  }
  console.log(`[detox-stage:done] ${step.stage}`);
}

describe("HotUpdater Detox scenarios", () => {
  beforeAll(async () => {
    ({ createControlClient } = await import("./control-client.ts"));
    ({ getDetoxScenarioDefinition } = await import("./scenarios.ts"));
  });

  beforeEach(async () => {
    controlClient = createControlClient({
      baseUrl: controlBaseUrl(),
      onStageTiming: (timing) => {
        console.log(`[detox-stage:timing] ${JSON.stringify(timing)}`);
      },
    });
    stageValues = {};
    if (isAndroidRun()) {
      for (const port of androidReversePorts()) {
        await device.reverseTcpPort(port);
      }
    }
    await controlClient.runJob("bootstrap", "/e2e/jobs/bootstrap", {});
    await controlClient.postJson(
      "reset remote bundles",
      "/e2e/reset-remote-bundles",
      {},
    );
    await controlClient.postJson("reset local app state", "/e2e/reset-local-app-state", {});
    await device.launchApp({ newInstance: true });
    markSynchronizationRestoredByLaunch();
  });

  afterEach(async () => {
    await device.terminateApp();
    if (isAndroidRun()) {
      for (const port of androidReversePorts()) {
        await device.unreverseTcpPort(port);
      }
    }
  });

  afterAll(async () => {
    if (controlClient) {
      await controlClient.postJson("cleanup", "/e2e/cleanup", {});
    }
  });

  for (const scenarioName of scenarioNames) {
    it(scenarioName, async () => {
      const scenario = getDetoxScenarioDefinition(scenarioName);
      for (const step of scenario.steps) {
        await runScenarioStep(step);
      }
    });
  }
});

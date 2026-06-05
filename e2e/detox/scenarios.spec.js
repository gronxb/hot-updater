const {
  by,
  device,
  element,
  expect: detoxExpect,
  waitFor,
} = require("detox");
const { createControlClient } = require("./control-client.ts");
const {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
} = require("./scenarios.ts");

const scenarioNames = listDetoxScenarioNames();

let controlClient;
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

function runtimeLaunchArgs() {
  const launchArgs = {};
  const runtimeConfigURL = process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL;
  const appBaseURL =
    process.env.HOT_UPDATER_E2E_APP_BASE_URL ||
    process.env.HOT_UPDATER_APP_BASE_URL;
  if (runtimeConfigURL) {
    launchArgs.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL = runtimeConfigURL;
  }
  if (appBaseURL) {
    launchArgs.HOT_UPDATER_APP_BASE_URL = appBaseURL;
  }
  return launchArgs;
}

async function launchApp(options = {}) {
  await device.launchApp({ ...options, launchArgs: runtimeLaunchArgs() });
  markSynchronizationRestoredByLaunch();
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

function shouldDisableSynchronizationForTap(testID) {
  return testID.startsWith("action-install-");
}

function markSynchronizationRestoredByLaunch() {
  synchronizationDisabledUntilLaunch = false;
}

async function disableSynchronizationUntilLaunch() {
  if (synchronizationDisabledUntilLaunch) return;
  await device.disableSynchronization();
  synchronizationDisabledUntilLaunch = true;
}

function navTargetForTestID(testID) {
  if (
    testID.startsWith("action-set-") ||
    testID === "action-restore-initial-cohort"
  ) {
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

class DetoxScenarioRuntime {
  constructor(client) {
    this.controlClient = client;
    this.stageValues = {};
  }

  async assertText(stage, testID, contains, options = {}) {
    await this.runStage(stage, async () => {
      const target = await this.waitForTestID(testID, {
        ensureForeground: options.ensureForeground,
      });
      await detoxExpect(target).toBeVisible();
      const text = textFromAttributes(await target.getAttributes());
      const expectedText = String(this.resolvePlaceholders(contains));
      if (!text.includes(expectedText)) {
        throw new Error(
          `${stage} expected ${testID} to contain "${expectedText}", received "${text}"`,
        );
      }
    });
  }

  async control(stage, pathName, body, options = {}) {
    await this.runStage(stage, async () => {
      const resolvedBody = this.resolvePlaceholders(body);
      const runner = pathName.startsWith("/e2e/jobs/")
        ? this.controlClient.runJob.bind(this.controlClient)
        : this.controlClient.postJson.bind(this.controlClient);
      const result = await runner(stage, pathName, resolvedBody);
      this.saveControlResult(options, result);
      await this.reattachAfterExternalLaunch(pathName);
    });
  }

  async launch(stage) {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: prepare launch`,
        "/e2e/prepare-app-launch",
        {},
      );
      try {
        await launchApp({ newInstance: true });
      } catch (error) {
        if (!stage.toLowerCase().includes("crash")) throw error;
      }
    });
  }

  async reload(stage) {
    await this.runStage(stage, async () => {
      await device.terminateApp();
      await launchApp({ newInstance: true });
    });
  }

  async resetAppState(stage) {
    await this.runStage(stage, async () => {
      await this.controlClient.postJson(
        `${stage}: reset local app state`,
        "/e2e/reset-local-app-state",
        {},
      );
      await launchApp({ newInstance: true });
    });
  }

  async tap(stage, testID) {
    await this.runStage(stage, async () => {
      const target = await this.waitForTestID(testID);
      if (shouldDisableSynchronizationForTap(testID)) {
        await disableSynchronizationUntilLaunch();
      }
      await target.tap();
    });
  }

  async terminate(stage) {
    await this.runStage(stage, async () => {
      await device.terminateApp();
    });
  }

  async typeText(stage, testID, text) {
    await this.runStage(stage, async () => {
      const target = await this.waitForTestID(testID);
      await target.replaceText(String(this.resolvePlaceholders(text)));
    });
  }

  readStageValue(key) {
    if (Object.hasOwn(this.stageValues, key)) return this.stageValues[key];
    throw new Error(`Missing Detox scenario value: ${key}`);
  }

  resolvePlaceholders(value) {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.indexOf("$", 1) === -1) {
        return this.readStageValue(value.slice(1));
      }
      return value.replace(/\$([A-Za-z0-9_]+)/g, (_, key) =>
        String(this.readStageValue(key)),
      );
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolvePlaceholders(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.resolvePlaceholders(item),
        ]),
      );
    }
    return value;
  }

  async runStage(stage, operation) {
    console.log(`[detox-stage:start] ${stage}`);
    try {
      await operation();
      console.log(`[detox-stage:done] ${stage}`);
    } catch (error) {
      console.log(`[detox-stage:failed] ${stage}`);
      throw error;
    }
  }

  saveControlResult(options, result) {
    for (const [key, value] of Object.entries(result)) {
      this.stageValues[key] = value;
    }
    for (const [sourceKey, targetKey] of Object.entries(
      options.saveResultFieldsAs || {},
    )) {
      if (Object.hasOwn(result, sourceKey)) {
        this.stageValues[targetKey] = result[sourceKey];
      }
    }
    if (!options.saveResultAs) return;
    if (typeof result[options.saveResultAs] === "string") {
      this.stageValues[options.saveResultAs] = result[options.saveResultAs];
      return;
    }
    if (typeof result.bundleId === "string") {
      this.stageValues[options.saveResultAs] = result.bundleId;
      return;
    }
    if (typeof result.builtInBundleId === "string") {
      this.stageValues[options.saveResultAs] = result.builtInBundleId;
    }
  }

  async ensureAppForegroundForInteraction() {
    await this.controlClient.postJson(
      "ensure app foreground",
      "/e2e/ensure-app-foreground",
      {},
    );
    if (isAndroidRun()) {
      await device.sendToHome();
      await launchApp({ newInstance: false });
    }
  }

  async reattachAfterExternalLaunch(pathName) {
    if (!isAndroidRun()) return;
    if (pathName !== "/e2e/wait-for-crash-recovery") return;
    await launchApp({ newInstance: false });
  }

  async waitForTestID(testID, options = {}) {
    if (options.ensureForeground !== false) {
      await this.ensureAppForegroundForInteraction();
    }
    await navigateToTestID(testID);
    const target = element(by.id(testID));
    await waitFor(target)
      .toBeVisible()
      .whileElement(by.id("e2e-scroll-content"))
      .scroll(260, "down");
    await waitFor(target).toBeVisible().withTimeout(30000);
    return target;
  }
}

describe("HotUpdater Detox scenarios", () => {
  beforeEach(async () => {
    controlClient = createControlClient({
      baseUrl: controlBaseUrl(),
      onStageTiming: (timing) => {
        console.log(`[detox-stage:timing] ${JSON.stringify(timing)}`);
      },
    });
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
    await controlClient.postJson(
      "reset local app state",
      "/e2e/reset-local-app-state",
      {},
    );
    await launchApp({ newInstance: true });
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
      const driver = new DetoxScenarioRuntime(controlClient);
      await scenario.run(driver);
    });
  }
});

const { device } = require("detox");
const { createControlClient } = require("./control-client.ts");
const {
  getDetoxScenarioDefinition,
  listDetoxScenarioNames,
} = require("./scenarios.ts");
const {
  androidReversePorts,
  controlBaseUrl,
  isAndroidRun,
  launchApp,
} = require("./detox-page.js");
const { DetoxAppDriver } = require("./detox-app-driver.js");

const scenarioNames = listDetoxScenarioNames();

let controlClient;

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
      const app = new DetoxAppDriver(controlClient);
      await scenario.run(app);
    });
  }
});

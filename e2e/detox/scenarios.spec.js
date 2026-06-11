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
} = require("./detox-page.js");
const { DetoxAppDriver } = require("./detox-app-driver.js");

const scenarioNames = listDetoxScenarioNames();

let controlClient;
let bootstrapResult = {};

describe("HotUpdater Detox scenarios", () => {
  beforeEach(async () => {
    bootstrapResult = {};
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
    bootstrapResult = await controlClient.runJob(
      "bootstrap",
      "/e2e/jobs/bootstrap",
      {},
    );
    await controlClient.runJob(
      "reset remote bundles",
      "/e2e/jobs/reset-remote-bundles",
      {},
    );
    await controlClient.postJson(
      "reset local app state",
      "/e2e/reset-local-app-state",
      {},
    );
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
      const app = new DetoxAppDriver(controlClient, bootstrapResult);
      await scenario.run(app);
    });
  }
});

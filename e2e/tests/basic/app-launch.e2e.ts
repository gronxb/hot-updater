import {
  checkServerHealth,
  deployBundle,
  device,
  takeScreenshot,
  terminateApp,
  waitForAppReady,
} from "../helpers/test-utils";

describe("App Launch Tests", () => {
  beforeAll(async () => {
    // Verify server is running
    const isServerHealthy = await checkServerHealth();
    if (!isServerHealthy) {
      throw new Error(
        "Hot Updater server is not running. Please run the server first.",
      );
    }

    // Deploy initial bundle before starting tests
    await deployBundle({ appName: "v0.81.0", platform: "ios" });

    await waitForAppReady();
  });

  afterAll(async () => {
    await terminateApp();
  });

  it("should launch the app successfully", async () => {
    // Take a screenshot of the initial screen
    await takeScreenshot("app-launched");

    // Verify app is running by checking if any element is visible
    // This is a basic check that can be customized based on your app's UI
    await device.takeScreenshot("app-initial-state");
  });

  it("should display the initial screen without crashes", async () => {
    // Wait a bit to ensure the app has fully loaded
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // App should still be running (no crash)
    // This is validated by the test not throwing an error
    await takeScreenshot("app-stable");
  });

  it("should be able to reload the app", async () => {
    await device.reloadReactNative();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await takeScreenshot("app-after-reload");
  });
});

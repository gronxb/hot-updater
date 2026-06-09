const { by, device, element, waitFor } = require("detox");
const {
  E2E_SCREEN_CONTENT_TEST_IDS,
  E2E_SCREEN_URLS,
  screenPathForTestID,
} = require("./detox-screen-routes.js");

let synchronizationDisabledUntilLaunch = false;
let activeScreenPath;

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
  synchronizationDisabledUntilLaunch = false;
  if (options.newInstance !== false) {
    activeScreenPath = undefined;
    return;
  }
  if (typeof options.url === "string") activeScreenPath = undefined;
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

async function disableSynchronizationUntilLaunch() {
  if (synchronizationDisabledUntilLaunch) return;
  await device.disableSynchronization();
  synchronizationDisabledUntilLaunch = true;
}

async function waitForActiveScreen(screenContentTestID) {
  await waitFor(element(by.id(screenContentTestID)))
    .toBeVisible()
    .withTimeout(30000);
}

async function withSynchronizationDisabledForPageOpen(operation) {
  await disableSynchronizationUntilLaunch();
  return operation();
}

async function openScreenForTestID(testID) {
  const screenPath = screenPathForTestID(testID);
  if (activeScreenPath === screenPath) {
    await waitForActiveScreen(E2E_SCREEN_CONTENT_TEST_IDS[screenPath]);
    return;
  }

  await withSynchronizationDisabledForPageOpen(async () => {
    await openDeepLinkScreen(E2E_SCREEN_URLS[screenPath]);
    await disableSynchronizationUntilLaunch();
    await waitForActiveScreen(E2E_SCREEN_CONTENT_TEST_IDS[screenPath]);
    activeScreenPath = screenPath;
  });
}

async function openDeepLinkScreen(url) {
  if (isAndroidRun()) {
    await launchApp({ newInstance: false, url });
    return;
  }

  await launchApp({ newInstance: false });
  await disableSynchronizationUntilLaunch();
  await device.openURL({ url });
  synchronizationDisabledUntilLaunch = false;
  await disableSynchronizationUntilLaunch();
}

async function ensureAppForegroundForInteraction() {
  if (isAndroidRun()) {
    await launchApp({ newInstance: false });
  }
}

async function findVisibleTestID(controlClient, testID, options = {}) {
  if (options.ensureForeground !== false) {
    await ensureAppForegroundForInteraction();
  }
  await openScreenForTestID(testID);
  const target = element(by.id(testID));
  await waitFor(target).toBeVisible().withTimeout(30000);
  return target;
}

async function withSynchronizationDisabledForAssertion(operation) {
  await disableSynchronizationUntilLaunch();
  return operation();
}

module.exports = {
  androidReversePorts,
  controlBaseUrl,
  disableSynchronizationUntilLaunch,
  findVisibleTestID,
  isAndroidRun,
  launchApp,
  textFromAttributes,
  withSynchronizationDisabledForAssertion,
};

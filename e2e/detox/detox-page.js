const { by, device, element, waitFor } = require("detox");

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

function markSynchronizationRestoredByLaunch() {
  synchronizationDisabledUntilLaunch = false;
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

async function disableSynchronizationUntilLaunch(options = {}) {
  const force = options.force === true;
  if (synchronizationDisabledUntilLaunch && !force) return;
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

async function ensureAppForegroundForInteraction() {
  if (isAndroidRun()) {
    await launchApp({ newInstance: false });
  }
}

async function findVisibleTestID(controlClient, testID, options = {}) {
  if (options.ensureForeground !== false) {
    await ensureAppForegroundForInteraction();
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

module.exports = {
  androidReversePorts,
  controlBaseUrl,
  disableSynchronizationUntilLaunch,
  findVisibleTestID,
  isAndroidRun,
  launchApp,
  shouldDisableSynchronizationForTap,
  textFromAttributes,
};

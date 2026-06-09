const { by, device, element, waitFor } = require("detox");

let synchronizationDisabledUntilLaunch = false;

const E2E_SCREEN_URLS = {
  actions: "hotupdaterexample://e2e/actions",
  cohorts: "hotupdaterexample://e2e/cohorts",
  results: "hotupdaterexample://e2e/results",
  runtime: "hotupdaterexample://e2e/runtime",
};

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldDisableSynchronizationForTap(testID) {
  return testID.startsWith("action-install-");
}

async function disableSynchronizationUntilLaunch() {
  if (synchronizationDisabledUntilLaunch) return;
  await device.disableSynchronization();
  synchronizationDisabledUntilLaunch = true;
}

function screenPathForTestID(testID) {
  if (
    testID.startsWith("action-set-") ||
    testID === "action-restore-initial-cohort"
  ) {
    return "cohorts";
  }
  if (testID.startsWith("action-") || testID.endsWith("-input")) {
    return "actions";
  }
  if (
    testID === "launch-status-result" ||
    testID === "launch-crashed-bundle-result" ||
    testID === "current-channel-summary" ||
    testID === "current-cohort-summary" ||
    testID === "update-store-downloaded" ||
    testID === "update-store-download-paths" ||
    testID === "crash-history-summary" ||
    testID.startsWith("runtime-")
  ) {
    return "runtime";
  }
  if (testID.endsWith("-result")) {
    return "results";
  }
  return "runtime";
}

async function openScreenForTestID(testID) {
  const screenPath = screenPathForTestID(testID);
  await launchApp({
    newInstance: false,
    url: E2E_SCREEN_URLS[screenPath],
  });
  const scrollContent = element(by.id("e2e-scroll-content"));
  await waitFor(scrollContent).toBeVisible().withTimeout(30000);
  await scrollContent.scrollTo("top");
}

async function ensureAppForegroundForInteraction() {
  if (isAndroidRun()) {
    await launchApp({ newInstance: false });
  }
}

async function waitForVisibleTestIDText(testID, expectedText) {
  await waitFor(
    element(by.id(testID).and(by.text(new RegExp(escapeRegExp(expectedText))))),
  )
    .toBeVisible()
    .withTimeout(30000);
}

async function findVisibleTestID(controlClient, testID, options = {}) {
  if (options.ensureForeground !== false) {
    await ensureAppForegroundForInteraction();
  }
  await openScreenForTestID(testID);
  const target = element(by.id(testID));
  await waitFor(target)
    .toBeVisible()
    .whileElement(by.id("e2e-scroll-content"))
    .scroll(260, "down");
  await waitFor(target).toBeVisible().withTimeout(30000);
  return target;
}

async function withSynchronizationDisabledForAssertion(operation) {
  const shouldRestoreSynchronization = !synchronizationDisabledUntilLaunch;
  if (shouldRestoreSynchronization) {
    await device.disableSynchronization();
  }

  try {
    return await operation();
  } finally {
    if (shouldRestoreSynchronization) {
      await device.enableSynchronization();
    }
  }
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
  waitForVisibleTestIDText,
  withSynchronizationDisabledForAssertion,
};

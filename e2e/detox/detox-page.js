const { by, device, element, waitFor } = require("detox");

let synchronizationDisabledUntilLaunch = false;

const E2E_SCREEN_URLS = {
  actionResults: "hotupdaterexample://e2e/results",
  cohortInputActions: "hotupdaterexample://e2e/cohort-input",
  cohortPresetActions: "hotupdaterexample://e2e/cohort-presets",
  crashHistory: "hotupdaterexample://e2e/crash-history",
  installActions: "hotupdaterexample://e2e/install",
  launchStatus: "hotupdaterexample://e2e/launch-status",
  runtimeChannelActions: "hotupdaterexample://e2e/runtime-channel",
  runtimeIdentity: "hotupdaterexample://e2e/runtime-identity",
  runtimeState: "hotupdaterexample://e2e/runtime-state",
  updateStore: "hotupdaterexample://e2e/update-store",
};

const E2E_SCREEN_CONTENT_TEST_IDS = {
  actionResults: "e2e-screen-action-results",
  cohortInputActions: "e2e-screen-cohort-input-actions",
  cohortPresetActions: "e2e-screen-cohort-preset-actions",
  crashHistory: "e2e-screen-crash-history",
  installActions: "e2e-screen-install-actions",
  launchStatus: "e2e-screen-launch-status",
  runtimeChannelActions: "e2e-screen-runtime-channel-actions",
  runtimeIdentity: "e2e-screen-runtime-identity",
  runtimeState: "e2e-screen-runtime-state",
  updateStore: "e2e-screen-update-store",
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
    return "cohortPresetActions";
  }
  if (testID === "cohort-input" || testID === "action-apply-cohort-input") {
    return "cohortInputActions";
  }
  if (
    testID === "runtime-channel-input" ||
    testID === "action-install-runtime-channel-update" ||
    testID === "action-reset-runtime-channel" ||
    testID === "action-reload-app"
  ) {
    return "runtimeChannelActions";
  }
  if (testID.startsWith("action-")) {
    return "installActions";
  }
  if (
    testID === "launch-status-result" ||
    testID === "launch-crashed-bundle-result"
  ) {
    return "launchStatus";
  }
  if (
    testID === "current-channel-summary" ||
    testID === "current-cohort-summary"
  ) {
    return "runtimeState";
  }
  if (
    testID === "update-store-downloaded" ||
    testID === "update-store-download-paths"
  ) {
    return "updateStore";
  }
  if (testID === "crash-history-summary") {
    return "crashHistory";
  }
  if (
    testID === "runtime-bundle-id" ||
    testID === "runtime-scenario-marker" ||
    testID === "runtime-large-e2e-asset" ||
    testID.startsWith("runtime-")
  ) {
    return "runtimeIdentity";
  }
  if (testID.endsWith("-result")) {
    return "actionResults";
  }
  return "runtimeIdentity";
}

async function waitForActiveScreen(screenContentTestID) {
  await waitFor(element(by.id(screenContentTestID)))
    .toBeVisible()
    .withTimeout(30000);
}

async function withSynchronizationDisabledForPageOpen(operation) {
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

async function openScreenForTestID(testID) {
  const screenPath = screenPathForTestID(testID);
  await launchApp({
    newInstance: false,
    url: E2E_SCREEN_URLS[screenPath],
  });
  await withSynchronizationDisabledForPageOpen(async () => {
    await waitForActiveScreen(E2E_SCREEN_CONTENT_TEST_IDS[screenPath]);
    const screenContent = element(by.id("e2e-screen-content"));
    await waitFor(screenContent).toBeVisible().withTimeout(30000);
  });
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

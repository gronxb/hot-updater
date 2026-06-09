const { by, device, element, waitFor } = require("detox");

let synchronizationDisabledUntilLaunch = false;

const E2E_SCREEN_URLS = {
  applyCohortInputAction: "hotupdaterexample://e2e/action/apply-cohort-input",
  channelActionResult: "hotupdaterexample://e2e/channel-action-result",
  cohortActionResult: "hotupdaterexample://e2e/cohort-action-result",
  cohortInput: "hotupdaterexample://e2e/input/cohort",
  crashHistory: "hotupdaterexample://e2e/crash-history",
  clearCrashHistoryAction:
    "hotupdaterexample://e2e/action/clear-crash-history",
  installCurrentChannelUpdateAction:
    "hotupdaterexample://e2e/action/install-current-channel-update",
  installRuntimeChannelUpdateAction:
    "hotupdaterexample://e2e/action/install-runtime-channel-update",
  launchCrashedBundle: "hotupdaterexample://e2e/launch-crashed-bundle",
  launchStatus: "hotupdaterexample://e2e/launch-status",
  runtimeBundle: "hotupdaterexample://e2e/runtime-bundle",
  runtimeChannelInput: "hotupdaterexample://e2e/input/runtime-channel",
  runtimeChannelSummary: "hotupdaterexample://e2e/runtime-channel-summary",
  runtimeCohortSummary: "hotupdaterexample://e2e/runtime-cohort-summary",
  runtimeLargeAsset: "hotupdaterexample://e2e/runtime-large-asset",
  runtimeMarker: "hotupdaterexample://e2e/runtime-marker",
  refreshRuntimeSnapshotAction:
    "hotupdaterexample://e2e/action/refresh-runtime-snapshot",
  reloadAppAction: "hotupdaterexample://e2e/action/reload-app",
  resetRuntimeChannelAction:
    "hotupdaterexample://e2e/action/reset-runtime-channel",
  restoreInitialCohortAction:
    "hotupdaterexample://e2e/action/restore-initial-cohort",
  setCohortQaAction: "hotupdaterexample://e2e/action/set-cohort-qa",
  updateActionResult: "hotupdaterexample://e2e/update-action-result",
  updateStoreDownloaded: "hotupdaterexample://e2e/update-store-downloaded",
  updateStoreDownloadPaths:
    "hotupdaterexample://e2e/update-store-download-paths",
};

const E2E_SCREEN_CONTENT_TEST_IDS = {
  applyCohortInputAction: "e2e-screen-action-apply-cohort-input",
  channelActionResult: "e2e-screen-channel-action-result",
  cohortActionResult: "e2e-screen-cohort-action-result",
  cohortInput: "e2e-screen-input-cohort",
  crashHistory: "e2e-screen-crash-history",
  clearCrashHistoryAction: "e2e-screen-action-clear-crash-history",
  installCurrentChannelUpdateAction:
    "e2e-screen-action-install-current-channel-update",
  installRuntimeChannelUpdateAction:
    "e2e-screen-action-install-runtime-channel-update",
  launchCrashedBundle: "e2e-screen-launch-crashed-bundle",
  launchStatus: "e2e-screen-launch-status",
  runtimeBundle: "e2e-screen-runtime-bundle",
  runtimeChannelInput: "e2e-screen-input-runtime-channel",
  runtimeChannelSummary: "e2e-screen-runtime-channel-summary",
  runtimeCohortSummary: "e2e-screen-runtime-cohort-summary",
  runtimeLargeAsset: "e2e-screen-runtime-large-asset",
  runtimeMarker: "e2e-screen-runtime-marker",
  refreshRuntimeSnapshotAction:
    "e2e-screen-action-refresh-runtime-snapshot",
  reloadAppAction: "e2e-screen-action-reload-app",
  resetRuntimeChannelAction: "e2e-screen-action-reset-runtime-channel",
  restoreInitialCohortAction:
    "e2e-screen-action-restore-initial-cohort",
  setCohortQaAction: "e2e-screen-action-set-cohort-qa",
  updateActionResult: "e2e-screen-update-action-result",
  updateStoreDownloaded: "e2e-screen-update-store-downloaded",
  updateStoreDownloadPaths: "e2e-screen-update-store-download-paths",
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

async function launchApp(options = {}) {
  await device.launchApp({ ...options, launchArgs: runtimeLaunchArgs() });
  synchronizationDisabledUntilLaunch = false;
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

async function disableSynchronizationUntilLaunch() {
  if (synchronizationDisabledUntilLaunch) return;
  await device.disableSynchronization();
  synchronizationDisabledUntilLaunch = true;
}

const TEST_ID_SCREEN_PATHS = {
  "action-apply-cohort-input": "applyCohortInputAction",
  "action-clear-crash-history": "clearCrashHistoryAction",
  "action-install-current-channel-update":
    "installCurrentChannelUpdateAction",
  "action-install-runtime-channel-update":
    "installRuntimeChannelUpdateAction",
  "action-refresh-runtime-snapshot": "refreshRuntimeSnapshotAction",
  "action-reload-app": "reloadAppAction",
  "action-reset-runtime-channel": "resetRuntimeChannelAction",
  "action-restore-initial-cohort": "restoreInitialCohortAction",
  "action-set-cohort-qa": "setCohortQaAction",
  "channel-action-result": "channelActionResult",
  "cohort-action-result": "cohortActionResult",
  "cohort-input": "cohortInput",
  "crash-history-summary": "crashHistory",
  "current-channel-summary": "runtimeChannelSummary",
  "current-cohort-summary": "runtimeCohortSummary",
  "launch-crashed-bundle-result": "launchCrashedBundle",
  "launch-status-result": "launchStatus",
  "runtime-bundle-id": "runtimeBundle",
  "runtime-large-e2e-asset": "runtimeLargeAsset",
  "runtime-scenario-marker": "runtimeMarker",
  "runtime-channel-input": "runtimeChannelInput",
  "update-action-result": "updateActionResult",
  "update-store-downloaded": "updateStoreDownloaded",
  "update-store-download-paths": "updateStoreDownloadPaths",
};

function screenPathForTestID(testID) {
  return TEST_ID_SCREEN_PATHS[testID] || "runtimeBundle";
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
  await withSynchronizationDisabledForPageOpen(async () => {
    await device.openURL({ url: E2E_SCREEN_URLS[screenPath] });
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
  withSynchronizationDisabledForAssertion,
};

const E2E_SCREEN_URLS = {
  applyCohortInputAction: "hotupdaterexample://e2e/action/apply-cohort-input",
  channelActionResult: "hotupdaterexample://e2e/channel-action-result",
  cohortActionResult: "hotupdaterexample://e2e/cohort-action-result",
  cohortInput: "hotupdaterexample://e2e/input/cohort",
  crashHistoryCount: "hotupdaterexample://e2e/crash-history-count",
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
  runtimeChannelSwitched: "hotupdaterexample://e2e/runtime-channel-switched",
  runtimeCurrentChannel: "hotupdaterexample://e2e/runtime-current-channel",
  runtimeCurrentCohort: "hotupdaterexample://e2e/runtime-current-cohort",
  runtimeDefaultChannel: "hotupdaterexample://e2e/runtime-default-channel",
  runtimeInitialCohort: "hotupdaterexample://e2e/runtime-initial-cohort",
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
  crashHistoryCount: "e2e-screen-crash-history-count",
  clearCrashHistoryAction: "e2e-screen-action-clear-crash-history",
  installCurrentChannelUpdateAction:
    "e2e-screen-action-install-current-channel-update",
  installRuntimeChannelUpdateAction:
    "e2e-screen-action-install-runtime-channel-update",
  launchCrashedBundle: "e2e-screen-launch-crashed-bundle",
  launchStatus: "e2e-screen-launch-status",
  runtimeBundle: "e2e-screen-runtime-bundle",
  runtimeChannelInput: "e2e-screen-input-runtime-channel",
  runtimeChannelSwitched: "e2e-screen-runtime-channel-switched",
  runtimeCurrentChannel: "e2e-screen-runtime-current-channel",
  runtimeCurrentCohort: "e2e-screen-runtime-current-cohort",
  runtimeDefaultChannel: "e2e-screen-runtime-default-channel",
  runtimeInitialCohort: "e2e-screen-runtime-initial-cohort",
  runtimeLargeAsset: "e2e-screen-runtime-large-asset",
  runtimeMarker: "e2e-screen-runtime-marker",
  refreshRuntimeSnapshotAction:
    "e2e-screen-action-refresh-runtime-snapshot",
  reloadAppAction: "e2e-screen-action-reload-app",
  resetRuntimeChannelAction: "e2e-screen-action-reset-runtime-channel",
  restoreInitialCohortAction: "e2e-screen-action-restore-initial-cohort",
  setCohortQaAction: "e2e-screen-action-set-cohort-qa",
  updateActionResult: "e2e-screen-update-action-result",
  updateStoreDownloaded: "e2e-screen-update-store-downloaded",
  updateStoreDownloadPaths: "e2e-screen-update-store-download-paths",
};

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
  "crash-history-count": "crashHistoryCount",
  "runtime-channel-switched": "runtimeChannelSwitched",
  "runtime-current-channel": "runtimeCurrentChannel",
  "runtime-current-cohort": "runtimeCurrentCohort",
  "runtime-default-channel": "runtimeDefaultChannel",
  "runtime-initial-cohort": "runtimeInitialCohort",
  "launch-crashed-bundle-result": "launchCrashedBundle",
  "launch-status-result": "launchStatus",
  "runtime-bundle-id": "runtimeBundle",
  "runtime-large-e2e-asset": "runtimeLargeAsset",
  "runtime-scenario-marker": "runtimeMarker",
  "runtime-channel-input": "runtimeChannelInput",
  "update-action-result": "updateActionResult",
  "update-action-start": "updateActionResult",
  "update-store-downloaded": "updateStoreDownloaded",
  "update-store-download-paths": "updateStoreDownloadPaths",
};

function screenPathForTestID(testID) {
  return TEST_ID_SCREEN_PATHS[testID] || "runtimeBundle";
}

module.exports = {
  E2E_SCREEN_CONTENT_TEST_IDS,
  E2E_SCREEN_URLS,
  screenPathForTestID,
};

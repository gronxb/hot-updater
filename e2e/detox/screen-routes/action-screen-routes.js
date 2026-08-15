const ACTION_SCREEN_URLS = {
  applyCapturedUpdateAction:
    "hotupdaterexample://e2e/action/apply-captured-update",
  applyCohortInputAction: "hotupdaterexample://e2e/action/apply-cohort-input",
  captureCurrentChannelUpdateAction:
    "hotupdaterexample://e2e/action/capture-current-channel-update",
  clearCrashHistoryAction:
    "hotupdaterexample://e2e/action/clear-crash-history",
  installCurrentChannelUpdateAction:
    "hotupdaterexample://e2e/action/install-current-channel-update",
  installFingerprintUpdateAction:
    "hotupdaterexample://e2e/action/install-fingerprint-update",
  installRuntimeChannelUpdateAction:
    "hotupdaterexample://e2e/action/install-runtime-channel-update",
  refreshRuntimeSnapshotAction:
    "hotupdaterexample://e2e/action/refresh-runtime-snapshot",
  reloadAppAction: "hotupdaterexample://e2e/action/reload-app",
  resetRuntimeChannelAction:
    "hotupdaterexample://e2e/action/reset-runtime-channel",
  restoreInitialCohortAction:
    "hotupdaterexample://e2e/action/restore-initial-cohort",
  setCohortQaAction: "hotupdaterexample://e2e/action/set-cohort-qa",
};

const ACTION_TEST_ID_SCREEN_PATHS = {
  "action-apply-captured-update": "applyCapturedUpdateAction",
  "action-apply-cohort-input": "applyCohortInputAction",
  "action-capture-current-channel-update":
    "captureCurrentChannelUpdateAction",
  "action-clear-crash-history": "clearCrashHistoryAction",
  "action-install-current-channel-update":
    "installCurrentChannelUpdateAction",
  "action-install-fingerprint-update": "installFingerprintUpdateAction",
  "action-install-runtime-channel-update":
    "installRuntimeChannelUpdateAction",
  "action-refresh-runtime-snapshot": "refreshRuntimeSnapshotAction",
  "action-reload-app": "reloadAppAction",
  "action-reset-runtime-channel": "resetRuntimeChannelAction",
  "action-restore-initial-cohort": "restoreInitialCohortAction",
  "action-set-cohort-qa": "setCohortQaAction",
};

module.exports = { ACTION_SCREEN_URLS, ACTION_TEST_ID_SCREEN_PATHS };

const ACTION_SCREEN_URLS = {
  applyCohortInputAction: "hotupdaterexample://e2e/action/apply-cohort-input",
  clearCrashHistoryAction:
    "hotupdaterexample://e2e/action/clear-crash-history",
  installCurrentChannelUpdateAction:
    "hotupdaterexample://e2e/action/install-current-channel-update",
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
};

module.exports = { ACTION_SCREEN_URLS, ACTION_TEST_ID_SCREEN_PATHS };

const STATUS_SCREEN_URLS = {
  crashHistoryCount: "hotupdaterexample://e2e/crash-history-count",
  launchStatus: "hotupdaterexample://e2e/launch-status",
  launchTransition: "hotupdaterexample://e2e/launch-transition",
  clearUpdateLogsAction: "hotupdaterexample://e2e/action/clear-update-logs",
  updateLogs: "hotupdaterexample://e2e/update-logs",
  updateStatus: "hotupdaterexample://e2e/update-status",
};

const STATUS_TEST_ID_SCREEN_PATHS = {
  "crash-history-count": "crashHistoryCount",
  "launch-status-result": "launchStatus",
  "launch-transition-result": "launchTransition",
  "action-clear-update-logs": "clearUpdateLogsAction",
  "update-logs-result": "updateLogs",
  "update-status-result": "updateStatus",
};

module.exports = { STATUS_SCREEN_URLS, STATUS_TEST_ID_SCREEN_PATHS };

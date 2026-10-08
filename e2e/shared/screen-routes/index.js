const action = require("./action-screen-routes");
const input = require("./input-screen-routes");
const ready = require("./ready-screen-routes");
const remoteConfig = require("./remote-config-screen-routes");
const result = require("./result-screen-routes");
const runtime = require("./runtime-screen-routes");
const status = require("./status-screen-routes");

const E2E_SCREEN_URLS = {
  ...ready.READY_SCREEN_URLS,
  ...runtime.RUNTIME_SCREEN_URLS,
  ...status.STATUS_SCREEN_URLS,
  ...result.RESULT_SCREEN_URLS,
  ...input.INPUT_SCREEN_URLS,
  ...action.ACTION_SCREEN_URLS,
  ...remoteConfig.REMOTE_CONFIG_SCREEN_URLS,
};

const TEST_ID_SCREEN_PATHS = {
  ...ready.READY_TEST_ID_SCREEN_PATHS,
  ...runtime.RUNTIME_TEST_ID_SCREEN_PATHS,
  ...status.STATUS_TEST_ID_SCREEN_PATHS,
  ...result.RESULT_TEST_ID_SCREEN_PATHS,
  ...input.INPUT_TEST_ID_SCREEN_PATHS,
  ...action.ACTION_TEST_ID_SCREEN_PATHS,
  ...remoteConfig.REMOTE_CONFIG_TEST_ID_SCREEN_PATHS,
};

module.exports = { E2E_SCREEN_URLS, TEST_ID_SCREEN_PATHS };

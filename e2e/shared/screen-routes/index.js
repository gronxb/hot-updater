const {
  ACTION_SCREEN_URLS,
  ACTION_TEST_ID_SCREEN_PATHS,
} = require("./action-screen-routes");
const {
  INPUT_SCREEN_URLS,
  INPUT_TEST_ID_SCREEN_PATHS,
} = require("./input-screen-routes");
const {
  READY_SCREEN_URLS,
  READY_TEST_ID_SCREEN_PATHS,
} = require("./ready-screen-routes");
const {
  RESULT_SCREEN_URLS,
  RESULT_TEST_ID_SCREEN_PATHS,
} = require("./result-screen-routes");
const {
  RUNTIME_SCREEN_URLS,
  RUNTIME_TEST_ID_SCREEN_PATHS,
} = require("./runtime-screen-routes");
const {
  STATUS_SCREEN_URLS,
  STATUS_TEST_ID_SCREEN_PATHS,
} = require("./status-screen-routes");

const E2E_SCREEN_URLS = {
  ...READY_SCREEN_URLS,
  ...RUNTIME_SCREEN_URLS,
  ...STATUS_SCREEN_URLS,
  ...RESULT_SCREEN_URLS,
  ...INPUT_SCREEN_URLS,
  ...ACTION_SCREEN_URLS,
};

const TEST_ID_SCREEN_PATHS = {
  ...READY_TEST_ID_SCREEN_PATHS,
  ...RUNTIME_TEST_ID_SCREEN_PATHS,
  ...STATUS_TEST_ID_SCREEN_PATHS,
  ...RESULT_TEST_ID_SCREEN_PATHS,
  ...INPUT_TEST_ID_SCREEN_PATHS,
  ...ACTION_TEST_ID_SCREEN_PATHS,
};

module.exports = { E2E_SCREEN_URLS, TEST_ID_SCREEN_PATHS };

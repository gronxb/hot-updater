const { E2E_SCREEN_URLS, TEST_ID_SCREEN_PATHS } = require("./screen-routes");

function screenPathForTestID(testID) {
  return TEST_ID_SCREEN_PATHS[testID] || "ready";
}

module.exports = {
  E2E_SCREEN_URLS,
  screenPathForTestID,
};

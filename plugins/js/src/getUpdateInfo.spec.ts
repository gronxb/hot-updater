import { setupGetUpdateInfoTestSuite, createDefaultHotUpdaterTestInstance } from "@hot-updater/core/test-utils";
import { describe } from "vitest";

describe("getUpdateInfo", () => {
  setupGetUpdateInfoTestSuite({
    createHotUpdater: createDefaultHotUpdaterTestInstance,
  });
});

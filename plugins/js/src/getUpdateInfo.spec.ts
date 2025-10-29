import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { describe } from "vitest";
import { getUpdateInfo } from "./getUpdateInfo";

describe("getUpdateInfo", () => {
  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});

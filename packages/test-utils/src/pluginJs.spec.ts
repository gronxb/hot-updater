import { getUpdateInfo, semverSatisfies } from "@hot-updater/js";
import { describe } from "vitest";

import { setupGetUpdateInfoTestSuite } from "./setupGetUpdateInfoTestSuite";
import { setupSemverSatisfiesTestSuite } from "./setupSemverSatisfiesTestSuite";

describe("@hot-updater/js getUpdateInfo", () => {
  setupGetUpdateInfoTestSuite({ getUpdateInfo });
});

describe("@hot-updater/js semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({ semverSatisfies });
});

import { semverSatisfies } from "@hot-updater/js";
import { describe } from "vitest";

import { setupSemverSatisfiesTestSuite } from "./setupSemverSatisfiesTestSuite";

describe("@hot-updater/js semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({ semverSatisfies });
});

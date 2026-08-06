import { semverSatisfies } from "@hot-updater/plugin-core";
import { describe } from "vitest";

import { setupSemverSatisfiesTestSuite } from "./setupSemverSatisfiesTestSuite";

describe("semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({ semverSatisfies });
});

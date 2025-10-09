import { setupSemverSatisfiesTestSuite } from "@hot-updater/core/test-utils";
import { describe } from "vitest";
import { semverSatisfies } from "@hot-updater/backend-core/src";

describe("semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({ semverSatisfies });
});
